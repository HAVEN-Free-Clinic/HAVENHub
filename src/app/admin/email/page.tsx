/**
 * /admin/email -- Email monitoring dashboard.
 *
 * Shows a paginated list of EmailLog rows with status/template/recipient
 * filters, global health-count cards, and a per-row Retry action for FAILED
 * emails. Gates on admin.manage_sync.
 */

import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { requirePermission } from "@/platform/auth/session";
import {
  listEmails,
  retryEmail,
  EMAIL_PAGE_SIZE,
  EmailNotFoundError,
  EmailStateError,
} from "@/modules/admin/services/email";
import { buildAuthorizeUrl, mailConnectionStatus } from "@/platform/email/oauth";
import type { EmailStatus } from "@prisma/client";
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

const VALID_STATUSES: EmailStatus[] = ["QUEUED", "SENT", "FAILED"];

const KNOWN_TEMPLATES = [
  "epic-onboarding",
  "epic-activation",
  "epic-password-reset",
  "compliance-reminder",
  "compliance-escalation",
] as const;

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

function statusTone(status: EmailStatus): BadgeTone {
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
    template?: string;
    q?: string;
    page?: string;
    error?: string;
    message?: string;
    retried?: string;
    connected?: string;
  }>;
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function EmailPage({ searchParams }: PageProps) {
  await requirePermission("admin.manage_sync");
  const sp = await searchParams;

  // Validate status param; drop if unrecognized.
  const statusParam = sp.status?.toUpperCase() as EmailStatus | undefined;
  const validatedStatus =
    statusParam && VALID_STATUSES.includes(statusParam)
      ? statusParam
      : undefined;

  // Validate template param; drop if unrecognized.
  const templateParam = sp.template;
  const validatedTemplate =
    templateParam &&
    KNOWN_TEMPLATES.includes(templateParam as (typeof KNOWN_TEMPLATES)[number])
      ? templateParam
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
  const connectedSuccess = sp.connected === "1";

  const [{ rows, total, counts }, mailConn] = await Promise.all([
    listEmails({
      status: validatedStatus,
      template: validatedTemplate,
      q,
      page,
    }),
    mailConnectionStatus(),
  ]);

  const pageCount = Math.max(1, Math.ceil(total / EMAIL_PAGE_SIZE));

  function hrefFor(p: number): string {
    const params = new URLSearchParams();
    if (validatedStatus) params.set("status", validatedStatus);
    if (validatedTemplate) params.set("template", validatedTemplate);
    if (q) params.set("q", q);
    params.set("page", String(p));
    return `/admin/email?${params.toString()}`;
  }

  // ---------------------------------------------------------------------------
  // Server action
  // ---------------------------------------------------------------------------

  async function retryAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("admin.manage_sync");
    const id = (formData.get("id") as string | null) ?? "";

    try {
      await retryEmail(actor.personId, id);
    } catch (err) {
      if (err instanceof EmailNotFoundError || err instanceof EmailStateError) {
        redirect(
          `/admin/email?error=validation&message=${encodeURIComponent(err.message)}`
        );
      }
      throw err;
    }

    revalidatePath("/admin/email");
    redirect("/admin/email?retried=1");
  }

  async function connectMailerAction() {
    "use server";
    await requirePermission("admin.manage_sync");
    // Build the authorize URL first (it throws when the OAuth app is not
    // configured) so an unconfigured mailer never sets a stray state cookie.
    // The redirect itself happens outside the try so its NEXT_REDIRECT is not
    // caught here.
    const state = crypto.randomUUID();
    let target: string;
    try {
      target = buildAuthorizeUrl({ state });
    } catch {
      redirect(
        `/admin/email?error=validation&message=${encodeURIComponent("Mailer OAuth is not configured.")}`
      );
    }
    (await cookies()).set("mailer_oauth_state", state, {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 600,
      path: "/",
    });
    redirect(target);
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="space-y-6">
      <PageHeader
        title="Email"
        description="Monitor outgoing email logs. Retry failed messages to re-queue them for the next drain pass."
        action={
          <div className="flex gap-4">
            <Link
              href="/admin/email/campaigns"
              className="text-sm font-medium underline underline-offset-2"
            >
              Campaigns
            </Link>
            <Link
              href="/admin/email/templates"
              className="text-sm font-medium underline underline-offset-2"
            >
              Manage templates
            </Link>
          </div>
        }
      />

      {/* Banners */}
      {errorMessage && <Alert tone="error">{errorMessage}</Alert>}
      {retriedSuccess && !errorMessage && (
        <Alert tone="success">Email re-queued.</Alert>
      )}
      {connectedSuccess && !errorMessage && (
        <Alert tone="success">Mailbox connected.</Alert>
      )}

      {/* Mailer connection panel */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white p-5">
        <div>
          <p className="text-sm font-medium text-slate-700">Mailer connection</p>
          {mailConn.connected ? (
            <p className="mt-1 text-sm text-slate-500">
              Connected as {mailConn.account ?? "unknown"} since {fmtDateTime(mailConn.connectedAt)}
            </p>
          ) : (
            <p className="mt-1 text-sm text-slate-500">
              Not connected. Connect a mailbox to send email via Microsoft Graph.
            </p>
          )}
        </div>
        <form action={connectMailerAction}>
          <Button type="submit" variant="outline">
            {mailConn.connected ? "Reconnect" : "Connect mailbox"}
          </Button>
        </form>
      </div>

      {/* Health stat cards */}
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Queued" value={counts.queued} />
        <StatCard
          label="Failed"
          value={counts.failed}
          tone={counts.failed > 0 ? "critical" : "default"}
        />
        <StatCard label="Sent today" value={counts.sentToday} />
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
            name="template"
            defaultValue={validatedTemplate ?? ""}
            aria-label="Filter by template"
          >
            <option value="">All templates</option>
            {KNOWN_TEMPLATES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex-1 min-w-44">
          <Input
            name="q"
            defaultValue={q ?? ""}
            placeholder="Recipient email..."
            aria-label="Search by recipient email"
          />
        </div>
        <Button type="submit" variant="outline" size="sm">
          Filter
        </Button>
      </form>

      {/* Table */}
      {rows.length === 0 ? (
        <p className="text-sm text-slate-400">No emails found.</p>
      ) : (
        <>
          <p className="text-sm text-slate-500">
            {total.toLocaleString()} {total === 1 ? "email" : "emails"}
          </p>

          <Table>
            <THead>
              <TR>
                <TH>Recipient</TH>
                <TH>Template</TH>
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
                  <TD className="font-medium text-sm">{row.toEmail}</TD>
                  <TD className="text-sm text-slate-600">{row.template}</TD>
                  <TD>
                    <Badge tone={statusTone(row.status)}>{row.status}</Badge>
                  </TD>
                  <TD className="tabular-nums text-sm text-slate-600">
                    {row.attempts}
                  </TD>
                  <TD className="text-sm text-slate-500 max-w-xs">
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
                      <span className="text-slate-300">-</span>
                    )}
                  </TD>
                  <TD className="tabular-nums text-sm text-slate-600 whitespace-nowrap">
                    {fmtDateTime(row.createdAt)}
                  </TD>
                  <TD className="tabular-nums text-sm text-slate-600 whitespace-nowrap">
                    {fmtDateTime(row.sentAt)}
                  </TD>
                  <TD>
                    {row.status === "FAILED" && (
                      <form action={retryAction}>
                        <input type="hidden" name="id" value={row.id} />
                        <ConfirmButton
                          label="Retry"
                          confirmLabel="Re-queue this email?"
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
