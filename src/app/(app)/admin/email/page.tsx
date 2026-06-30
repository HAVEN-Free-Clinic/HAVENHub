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
  retryAllFailedEmails,
  sendSenderTest,
  EMAIL_PAGE_SIZE,
  EmailNotFoundError,
  EmailStateError,
} from "@/modules/admin/services/email";
import { buildAuthorizeUrl, mailConnectionStatus, teamsScopesGranted } from "@/platform/email/oauth";
import {
  SENDER_CATEGORIES,
  listSenderRules,
  saveSenderRule,
  clearSenderRule,
  SenderRuleValidationError,
} from "@/platform/email/sender-rules";
import { getSetting } from "@/platform/settings/service";
import type { EmailStatus, EmailSenderScope } from "@prisma/client";
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
    retriedAll?: string;
    connected?: string;
    senderSaved?: string;
    senderError?: string;
    senderTested?: string;
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
  const retriedAllCount = sp.retriedAll ? parseInt(sp.retriedAll, 10) : 0;
  const retriedAllSuccess = retriedAllCount > 0;
  const connectedSuccess = sp.connected === "1";

  const senderSavedSuccess = sp.senderSaved === "1";
  const senderTestedSuccess = sp.senderTested === "1";
  const senderErrorMessage = sp.senderError ? decodeURIComponent(sp.senderError) : null;

  const [{ rows, total, counts }, mailConn, mailCred, senderRules, globalSender] =
    await Promise.all([
      listEmails({ status: validatedStatus, template: validatedTemplate, q, page }),
      mailConnectionStatus(),
      prisma.mailCredential.findUnique({ where: { id: "mailer" } }),
      listSenderRules(),
      getSetting<string>("email.sender"),
    ]);

  const categoryRuleByGroup = new Map(
    senderRules.filter((r) => r.scope === "CATEGORY").map((r) => [r.target, r])
  );

  const needsTeamsReconnect = mailCred != null && !teamsScopesGranted(mailCred.scope);

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

  async function retryAllAction() {
    "use server";
    const actor = await requirePermission("admin.manage_sync");
    const count = await retryAllFailedEmails(actor.personId);
    revalidatePath("/admin/email");
    redirect(`/admin/email?retriedAll=${count}`);
  }

  async function saveSenderAction(formData: FormData) {
    "use server";
    const a = await requirePermission("admin.manage_sync");
    const scope = formData.get("scope") as EmailSenderScope;
    const target = (formData.get("target") as string | null) ?? "";
    const fromEmail = ((formData.get("fromEmail") as string | null) ?? "").trim();
    const fromName = ((formData.get("fromName") as string | null) ?? "").trim();

    try {
      if (fromEmail === "") {
        await clearSenderRule(a.personId, scope, target);
      } else {
        await saveSenderRule(a.personId, scope, target, { fromEmail, fromName });
      }
    } catch (err) {
      if (err instanceof SenderRuleValidationError) {
        redirect(`/admin/email?senderError=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    revalidatePath("/admin/email");
    redirect("/admin/email?senderSaved=1");
  }

  async function testSenderAction(formData: FormData) {
    "use server";
    const a = await requirePermission("admin.manage_sync");
    const fromEmail = ((formData.get("fromEmail") as string | null) ?? "").trim();
    const fromName = ((formData.get("fromName") as string | null) ?? "").trim();
    const person = await prisma.person.findUnique({
      where: { id: a.personId },
      select: { contactEmail: true },
    });
    const toEmail = person?.contactEmail ?? "";
    if (fromEmail === "" || toEmail === "") {
      redirect(`/admin/email?senderError=${encodeURIComponent("A from address and a recipient are required to send a test.")}`);
    }
    try {
      await sendSenderTest(a.personId, { toEmail, fromEmail, fromName: fromName || null });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Test send failed.";
      redirect(`/admin/email?senderError=${encodeURIComponent(message)}`);
    }
    redirect("/admin/email?senderTested=1");
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
      {retriedAllSuccess && !errorMessage && (
        <Alert tone="success">
          {retriedAllCount} failed {retriedAllCount === 1 ? "email" : "emails"} re-queued.
        </Alert>
      )}
      {connectedSuccess && !errorMessage && (
        <Alert tone="success">Mailbox connected.</Alert>
      )}
      {senderSavedSuccess && !errorMessage && (
        <Alert tone="success">Sender address saved.</Alert>
      )}
      {senderTestedSuccess && !errorMessage && (
        <Alert tone="success">Test message sent. Check the inbox to confirm.</Alert>
      )}
      {senderErrorMessage && <Alert tone="error">{senderErrorMessage}</Alert>}

      {/* Mailer connection panel */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-surface p-5">
        <div>
          <p className="text-sm font-medium text-foreground-soft">Mailer connection</p>
          {mailConn.connected ? (
            <p className="mt-1 text-sm text-muted-foreground">
              Connected as {mailConn.account ?? "unknown"} since {fmtDateTime(mailConn.connectedAt)}
            </p>
          ) : (
            <p className="mt-1 text-sm text-muted-foreground">
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
      {needsTeamsReconnect && (
        <Alert tone="warning">
          Teams direct messages need an additional permission. Reconnect the mailbox to grant it.
        </Alert>
      )}

      {/* Per-category send-from addresses */}
      <div className="rounded-2xl border border-border bg-surface p-5 space-y-4">
        <div>
          <p className="text-sm font-medium text-foreground-soft">Send-from addresses</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Choose the address each category of email sends from. Leave blank to use the
            global default ({globalSender}). The connected mailbox must have Send-As rights
            on any address you enter. Use Send test to confirm.
          </p>
        </div>
        {SENDER_CATEGORIES.map((cat) => {
          const rule = categoryRuleByGroup.get(cat.group);
          return (
            <form
              key={cat.group}
              action={saveSenderAction}
              className="flex flex-wrap items-end gap-3 border-t border-border pt-4"
            >
              <input type="hidden" name="scope" value="CATEGORY" />
              <input type="hidden" name="target" value={cat.group} />
              <div className="w-40">
                <p className="text-sm font-medium">{cat.label}</p>
              </div>
              <div className="w-64">
                <Input
                  name="fromEmail"
                  type="email"
                  defaultValue={rule?.fromEmail ?? ""}
                  placeholder={globalSender}
                  aria-label={`${cat.label} from address`}
                />
              </div>
              <div className="w-48">
                <Input
                  name="fromName"
                  defaultValue={rule?.fromName ?? ""}
                  placeholder="Display name (optional)"
                  aria-label={`${cat.label} display name`}
                />
              </div>
              <Button type="submit" variant="outline" size="sm">
                Save
              </Button>
              <Button type="submit" formAction={testSenderAction} variant="ghost" size="sm">
                Send test
              </Button>
            </form>
          );
        })}
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

      {/* Bulk recovery: re-queue every FAILED row at once (e.g. after a
          transient transport outage exhausted retries on many rows). */}
      {counts.failed > 0 && (
        <div className="flex justify-end">
          <form action={retryAllAction}>
            <ConfirmButton
              size="sm"
              label={`Retry all failed (${counts.failed})`}
              confirmLabel={`Re-queue all ${counts.failed} failed ${
                counts.failed === 1 ? "email" : "emails"
              }?`}
            />
          </form>
        </div>
      )}

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
        <p className="text-sm text-subtle-foreground">No emails found.</p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
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
                  <TD className="text-sm text-foreground-soft">{row.template}</TD>
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
