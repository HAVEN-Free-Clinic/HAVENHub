/**
 * /admin/notifications -- Teams message monitoring dashboard.
 *
 * Shows a paginated list of TeamsMessage rows with status/type/recipient
 * filters, global health-count cards, and a per-row Retry action for FAILED,
 * FALLBACK, and LOGGED messages. Gates on admin.manage_sync.
 */

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { SearchX } from "lucide-react";
import { requirePermission } from "@/platform/auth/session";
import {
  listTeamsMessages,
  retryTeamsMessage,
  TEAMS_PAGE_SIZE,
  TeamsMessageNotFoundError,
  TeamsMessageStateError,
} from "@/modules/admin/services/teams-messages";
import { NOTIFICATION_TYPES } from "@/platform/notifications/registry";
import type { TeamsMessageStatus } from "@prisma/client";
import { prisma } from "@/platform/db";
import { PageHeader } from "@/platform/ui/page-header";
import { FilterBar, FilterField } from "@/platform/ui/filter-bar";
import { Input } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { DeliveryLogTable } from "@/modules/admin/components/delivery-log-table";
import { Pagination } from "@/platform/ui/pagination";
import { Alert } from "@/platform/ui/alert";
import { StatCard } from "@/platform/ui/stat-card";
import { EmptyState } from "@/platform/ui/empty-state";
import { TextLink } from "@/platform/ui/text-link";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_STATUSES: TeamsMessageStatus[] = ["QUEUED", "SENT", "FAILED", "FALLBACK", "LOGGED"];

const NOTIFICATION_TYPE_LABELS = new Map(NOTIFICATION_TYPES.map((t) => [t.key, t.label]));

type BadgeTone = "default" | "success" | "warning" | "critical";

/** Friendly text, never the raw enum -- the shared rule SupportStatusBadge states. */
const STATUS_LABELS: Record<TeamsMessageStatus, string> = {
  QUEUED: "Queued",
  SENT: "Sent",
  FAILED: "Failed",
  FALLBACK: "Sent by email",
  LOGGED: "Logged",
};

function statusTone(status: TeamsMessageStatus): BadgeTone {
  if (status === "SENT") return "success";
  if (status === "FAILED") return "critical"; // undelivered by any channel
  if (status === "FALLBACK") return "warning"; // delivered via email, not Teams
  return "default";
}

// ---------------------------------------------------------------------------
// Page props
// ---------------------------------------------------------------------------

type PageProps = {
  searchParams: Promise<{
    status?: string;
    type?: string;
    q?: string;
    page?: string;
  }>;
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function NotificationsPage({ searchParams }: PageProps) {
  await requirePermission("admin.manage_sync");
  const sp = await searchParams;

  // Validate status param; drop if unrecognized.
  const statusParam = sp.status?.toUpperCase() as TeamsMessageStatus | undefined;
  const validatedStatus =
    statusParam && VALID_STATUSES.includes(statusParam)
      ? statusParam
      : undefined;

  // Validate type param; drop if unrecognized.
  const typeParam = sp.type;
  const validatedType =
    typeParam && NOTIFICATION_TYPES.some((t) => t.key === typeParam)
      ? typeParam
      : undefined;

  const q = sp.q?.trim() || undefined;
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);

  const [{ rows, total }, counts] = await Promise.all([
    listTeamsMessages({
      status: validatedStatus,
      type: validatedType,
      q,
      page,
    }),
    Promise.all([
      prisma.teamsMessage.count({ where: { status: "QUEUED" } }),
      prisma.teamsMessage.count({ where: { status: "FAILED" } }),
      prisma.teamsMessage.count({ where: { status: "FALLBACK" } }),
      prisma.teamsMessage.count({ where: { status: "LOGGED" } }),
    ]).then(([queued, failed, fallback, logged]) => ({ queued, failed, fallback, logged })),
  ]);

  const pageCount = Math.max(1, Math.ceil(total / TEAMS_PAGE_SIZE));

  // ---------------------------------------------------------------------------
  // Server action
  // ---------------------------------------------------------------------------

  async function retryAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("admin.manage_sync");
    const id = (formData.get("id") as string | null) ?? "";

    try {
      await retryTeamsMessage(actor.personId, id);
    } catch (err) {
      if (
        err instanceof TeamsMessageNotFoundError ||
        err instanceof TeamsMessageStateError
      ) {
        redirect(
          `/admin/notifications?error=validation&message=${encodeURIComponent(err.message)}`
        );
      }
      throw err;
    }

    revalidatePath("/admin/notifications");
    redirect("/admin/notifications?retried=1");
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="space-y-6">
      <PageHeader
        title="Notifications"
        description="Monitor outgoing Teams messages. Retry failed messages to re-queue them for the next delivery pass."
      />

      {/* Intro line */}
      <p className="text-sm text-muted-foreground">
        Choose Email, Teams, or Both per notification type in{" "}
        <TextLink href="/admin/settings" className="font-medium">
          Settings &gt; Notifications
        </TextLink>
        .
      </p>

      {/* Log-mode warning: rows were recorded but never actually sent. */}
      {counts.logged > 0 && (
        <Alert tone="warning">
          {counts.logged} message(s) were recorded in Log mode and NOT actually
          sent. Set Email transport to Microsoft Graph in{" "}
          <TextLink href="/admin/settings" className="font-medium">
            Settings &gt; Email
          </TextLink>
          , then retry them.
        </Alert>
      )}

      {/* Health stat cards */}
      <div className="grid gap-4 sm:grid-cols-4">
        <StatCard label="Queued" value={counts.queued} />
        <StatCard
          label="Failed (undelivered)"
          value={counts.failed}
          tone={counts.failed > 0 ? "critical" : "default"}
        />
        <StatCard
          label="Fallback (emailed)"
          value={counts.fallback}
          tone={counts.fallback > 0 ? "warning" : "default"}
        />
        <StatCard
          label="Logged (not sent)"
          value={counts.logged}
          tone={counts.logged > 0 ? "critical" : "default"}
        />
      </div>

      {/* Filter bar (GET form) */}
      <FilterBar
        clearHref={validatedStatus || validatedType || q ? "/admin/notifications" : undefined}
        resultCount={{ total, noun: "message" }}
      >
        <FilterField label="Status">
          <Select name="status" defaultValue={validatedStatus ?? ""}>
            <option value="">All statuses</option>
            {VALID_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </FilterField>
        <FilterField label="Type" width="wide">
          <Select name="type" defaultValue={validatedType ?? ""}>
            <option value="">All types</option>
            {NOTIFICATION_TYPES.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
          </Select>
        </FilterField>
        <FilterField label="Recipient" width="grow">
          <Input type="search" name="q" defaultValue={q ?? ""} placeholder="Recipient name…" />
        </FilterField>
      </FilterBar>

      {/* Table */}
      {rows.length === 0 ? (
        <EmptyState
          icon={SearchX}
          title="No Teams messages found"
          description="No message matches these filters. Widen the date range or clear a filter above."
        />
      ) : (
        <>
          <DeliveryLogTable
            recipientHeader="Recipient"
            kindHeader="Type"
            retryAction={retryAction}
            retryConfirmLabel="Re-queue this Teams message?"
            rows={rows.map((row) => ({
              id: row.id,
              recipient: row.person.name,
              kind: NOTIFICATION_TYPE_LABELS.get(row.type) ?? row.type,
              status: STATUS_LABELS[row.status] ?? row.status,
              statusTone: statusTone(row.status),
              attempts: row.attempts,
              lastError: row.lastError,
              createdAt: row.createdAt,
              sentAt: row.sentAt,
              // Wider than email's: FALLBACK went out by another channel and
              // LOGGED never went out at all, so a re-queue still means
              // something for both.
              canRetry:
                row.status === "FAILED" || row.status === "FALLBACK" || row.status === "LOGGED",
            }))}
          />

          <Pagination page={page} pageCount={pageCount} basePath="/admin/notifications" params={sp} />
        </>
      )}
    </div>
  );
}
