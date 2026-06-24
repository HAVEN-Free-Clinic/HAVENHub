/**
 * /admin/notifications -- Teams message monitoring dashboard.
 *
 * Shows a paginated list of TeamsMessage rows with status/type/recipient
 * filters, global health-count cards, and a per-row Retry action for FAILED,
 * FALLBACK, and LOGGED messages. Gates on admin.manage_sync.
 */

import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
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
import { Badge } from "@/platform/ui/badge";
import { Button } from "@/platform/ui/button";
import { Input } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { Pagination } from "@/platform/ui/pagination";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { Alert } from "@/platform/ui/alert";
import { StatCard } from "@/platform/ui/stat-card";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_STATUSES: TeamsMessageStatus[] = ["QUEUED", "SENT", "FAILED", "FALLBACK", "LOGGED"];

const NOTIFICATION_TYPE_LABELS = new Map(NOTIFICATION_TYPES.map((t) => [t.key, t.label]));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtDateTime(d: Date | null): string {
  if (!d) return "-";
  const pad = (n: number) => String(n).padStart(2, "0");
  const year = d.getUTCFullYear();
  const month = pad(d.getUTCMonth() + 1);
  const day = pad(d.getUTCDate());
  const hours = pad(d.getUTCHours());
  const minutes = pad(d.getUTCMinutes());
  return `${year}-${month}-${day} ${hours}:${minutes} UTC`;
}

type BadgeTone = "default" | "success" | "critical";

function statusTone(status: TeamsMessageStatus): BadgeTone {
  if (status === "SENT") return "success";
  if (status === "FAILED") return "critical";
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
    error?: string;
    message?: string;
    retried?: string;
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

  const errorCode = sp.error ?? null;
  const errorMessage = errorCode
    ? errorCode === "validation" && sp.message
      ? decodeURIComponent(sp.message)
      : "An unexpected error occurred."
    : null;

  const retriedSuccess = sp.retried === "1";

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

  function hrefFor(p: number): string {
    const params = new URLSearchParams();
    if (validatedStatus) params.set("status", validatedStatus);
    if (validatedType) params.set("type", validatedType);
    if (q) params.set("q", q);
    params.set("page", String(p));
    return `/admin/notifications?${params.toString()}`;
  }

  // ---------------------------------------------------------------------------
  // Server action
  // ---------------------------------------------------------------------------

  async function retryAction(formData: FormData) {
    "use server";
    await requirePermission("admin.manage_sync");
    const id = (formData.get("id") as string | null) ?? "";

    try {
      await retryTeamsMessage(id);
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
        <Link
          href="/admin/settings"
          className="font-medium underline underline-offset-2"
        >
          Settings &gt; Notifications
        </Link>
        .
      </p>

      {/* Banners */}
      {errorMessage && <Alert tone="error">{errorMessage}</Alert>}
      {retriedSuccess && !errorMessage && (
        <Alert tone="success">Teams message re-queued.</Alert>
      )}

      {/* Log-mode warning: rows were recorded but never actually sent. */}
      {counts.logged > 0 && (
        <Alert tone="warning">
          {counts.logged} message(s) were recorded in Log mode and NOT actually
          sent. Set Email transport to Microsoft Graph in{" "}
          <Link
            href="/admin/settings"
            className="font-medium underline underline-offset-2"
          >
            Settings &gt; Email
          </Link>
          , then retry them.
        </Alert>
      )}

      {/* Health stat cards */}
      <div className="grid gap-4 sm:grid-cols-4">
        <StatCard label="Queued" value={counts.queued} />
        <StatCard
          label="Failed"
          value={counts.failed}
          tone={counts.failed > 0 ? "critical" : "default"}
        />
        <StatCard
          label="Fallback"
          value={counts.fallback}
          tone={counts.fallback > 0 ? "critical" : "default"}
        />
        <StatCard
          label="Logged (not sent)"
          value={counts.logged}
          tone={counts.logged > 0 ? "critical" : "default"}
        />
      </div>

      {/* Filter bar (GET form) */}
      <form method="GET" className="flex flex-wrap items-end gap-3">
        <div className="w-36">
          <Select
            name="status"
            defaultValue={validatedStatus ?? ""}
            aria-label="Filter by status"
          >
            <option value="">All statuses</option>
            {VALID_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-52">
          <Select
            name="type"
            defaultValue={validatedType ?? ""}
            aria-label="Filter by type"
          >
            <option value="">All types</option>
            {NOTIFICATION_TYPES.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex-1 min-w-44">
          <Input
            name="q"
            defaultValue={q ?? ""}
            placeholder="Recipient name..."
            aria-label="Search by recipient name"
          />
        </div>
        <Button type="submit" variant="outline" size="sm">
          Filter
        </Button>
      </form>

      {/* Table */}
      {rows.length === 0 ? (
        <p className="text-sm text-subtle-foreground">No Teams messages found.</p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {total.toLocaleString()} {total === 1 ? "message" : "messages"}
          </p>

          <Table>
            <THead>
              <TR>
                <TH>Recipient</TH>
                <TH>Type</TH>
                <TH>Status</TH>
                <TH>Attempts</TH>
                <TH>Last error</TH>
                <TH>Created</TH>
                <TH>Sent</TH>
                <TH></TH>
              </TR>
            </THead>
            <tbody>
              {rows.map((row) => (
                <TR key={row.id}>
                  <TD className="font-medium text-sm">{row.person.name}</TD>
                  <TD className="text-sm text-foreground-soft">{NOTIFICATION_TYPE_LABELS.get(row.type) ?? row.type}</TD>
                  <TD>
                    <Badge tone={statusTone(row.status)}>{row.status}</Badge>
                  </TD>
                  <TD className="tabular-nums text-sm text-foreground-soft">
                    {row.attempts}
                  </TD>
                  <TD className="text-sm text-muted-foreground max-w-xs">
                    {row.lastError ? (
                      <span
                        title={row.lastError}
                        className="block truncate max-w-[15rem]"
                      >
                        {row.lastError.length > 60
                          ? row.lastError.slice(0, 60) + "…"
                          : row.lastError}
                      </span>
                    ) : (
                      <span className="text-subtle-foreground">-</span>
                    )}
                  </TD>
                  <TD className="tabular-nums text-sm text-foreground-soft whitespace-nowrap">
                    {fmtDateTime(row.createdAt)}
                  </TD>
                  <TD className="tabular-nums text-sm text-foreground-soft whitespace-nowrap">
                    {fmtDateTime(row.sentAt)}
                  </TD>
                  <TD>
                    {(row.status === "FAILED" || row.status === "FALLBACK" || row.status === "LOGGED") && (
                      <form action={retryAction}>
                        <input type="hidden" name="id" value={row.id} />
                        <ConfirmButton
                          label="Retry"
                          confirmLabel="Re-queue this Teams message?"
                        />
                      </form>
                    )}
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>

          <Pagination page={page} pageCount={pageCount} hrefFor={hrefFor} />
        </>
      )}
    </div>
  );
}
