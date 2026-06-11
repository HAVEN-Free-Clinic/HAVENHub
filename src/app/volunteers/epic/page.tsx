/**
 * Epic request queue page for Volunteer Management.
 *
 * Access: requirePermission("volunteers.manage_epic").
 * The volunteers layout already gates on volunteers.view.
 *
 * NOTE on nested forms: HTML forbids nesting <form> elements. Per-row
 * Complete/Cancel/email forms are independent; the ticket-selection form
 * uses the HTML `form` attribute on its checkboxes so checkbox inputs live
 * outside those row forms but still submit with the ticket form. This is
 * standard HTML4/HTML5 form association; React 19 passes the attribute through
 * as-is and the browser handles it correctly.
 */

import { requirePermission } from "@/platform/auth/session";
import { prisma } from "@/platform/db";
import { businessDaysSince } from "@/platform/dates";
import { PageHeader } from "@/platform/ui/page-header";
import { Badge } from "@/platform/ui/badge";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { Pagination } from "@/platform/ui/pagination";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { Field, Input } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { Button } from "@/platform/ui/button";
import { Checkbox } from "@/platform/ui/checkbox";
import { Alert } from "@/platform/ui/alert";
import { StatCard } from "@/platform/ui/stat-card";
import { SelectAllCheckbox } from "./select-all-checkbox";
import {
  listEpicRequests,
  listTickets,
  emailHistory,
  createEpicRequest,
  completeRequest,
  cancelRequest,
  createTicket,
  setTicketServiceRequestNumber,
  closeTicket,
  sendEpicEmail,
  updateRequestDetails,
  EpicForbiddenError,
  EpicNotFoundError,
  EpicStateError,
} from "@/modules/volunteers/services/epic";
import type { EpicRequestStatus, EpicRequestKind, EmailLog } from "@prisma/client";
import type { EpicTemplateKey } from "@/platform/email/templates/epic";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALL_STATUSES: EpicRequestStatus[] = ["PENDING", "SUBMITTED", "COMPLETED", "CANCELLED"];
const ALL_KINDS: EpicRequestKind[] = ["NEW", "MODIFY", "RENEW"];

const STATUS_LABEL: Record<EpicRequestStatus, string> = {
  PENDING: "Pending",
  SUBMITTED: "Submitted",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

type Tone = "default" | "success" | "warning" | "critical";

const STATUS_TONE: Record<EpicRequestStatus, Tone> = {
  PENDING: "default",
  SUBMITTED: "warning",
  COMPLETED: "success",
  CANCELLED: "critical",
};

// Error codes mapped to user-friendly text
const ERROR_MESSAGES: Record<string, string> = {
  "person-not-found": "Person not found. Check the NetID or email and try again.",
  "forbidden": "You do not have permission for that action.",
  "not-found": "The requested item could not be found.",
  "state-error": "The action could not be completed due to the current state of the request.",
  "invalid-kind": "Invalid request kind.",
  "invalid-template": "Invalid email template.",
};

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function fmtDate(d: Date | null | undefined): string {
  if (!d) return "-";
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

// ---------------------------------------------------------------------------
// Page props
// ---------------------------------------------------------------------------

type PageProps = {
  searchParams: Promise<{
    status?: string;
    page?: string;
    error?: string;
  }>;
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function EpicQueuePage({ searchParams }: PageProps) {
  await requirePermission("volunteers.manage_epic");
  const sp = await searchParams;

  const rawStatus = sp.status;
  const statusFilter: EpicRequestStatus =
    rawStatus && (ALL_STATUSES as string[]).includes(rawStatus)
      ? (rawStatus as EpicRequestStatus)
      : "PENDING";

  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);

  const errorCode = sp.error ?? null;
  const errorMessage = errorCode
    ? (ERROR_MESSAGES[errorCode] ?? decodeURIComponent(errorCode))
    : null;

  // Fetch data
  const [requestData, tickets] = await Promise.all([
    listEpicRequests({ status: statusFilter, page }),
    listTickets(),
  ]);

  const { rows, total, counts } = requestData;
  const pageCount = Math.max(1, Math.ceil(total / 25));

  // Fetch email history for all persons on this page
  const personIds = rows.map((r) => r.person.id);
  const emailHistoryMap = personIds.length > 0 ? await emailHistory(personIds) : new Map();

  // Build filter-preserving href for pagination
  function buildHref(targetPage: number): string {
    const params = new URLSearchParams();
    params.set("status", statusFilter);
    params.set("page", String(targetPage));
    return `/volunteers/epic?${params.toString()}`;
  }

  // ---------------------------------------------------------------------------
  // Server actions - all re-check volunteers.manage_epic
  // ---------------------------------------------------------------------------

  async function newRequestAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("volunteers.manage_epic");
    const personKey = (formData.get("personKey") as string | null)?.trim() ?? "";
    const kind = (formData.get("kind") as string | null) ?? "";
    const jobTitle = (formData.get("jobTitle") as string | null) || null;
    const mirrorEpicId = (formData.get("mirrorEpicId") as string | null) || null;
    const notes = (formData.get("notes") as string | null) || null;

    if (!personKey) {
      redirect("/volunteers/epic?error=person-not-found");
    }
    if (!(ALL_KINDS as string[]).includes(kind)) {
      redirect("/volunteers/epic?error=invalid-kind");
    }

    // Inline prisma lookup: a single person lookup for the form submission.
    // No service function wraps this; it is intentionally kept here per task spec.
    const person = await prisma.person.findFirst({
      where: {
        OR: [
          { netId: personKey },
          { contactEmail: { equals: personKey, mode: "insensitive" } },
        ],
      },
      select: { id: true },
    });

    if (!person) {
      redirect("/volunteers/epic?error=person-not-found");
    }

    try {
      await createEpicRequest(actor.personId, {
        personId: person.id,
        kind: kind as EpicRequestKind,
        jobTitle,
        mirrorEpicId,
        notes,
      });
    } catch (err) {
      if (err instanceof EpicForbiddenError) {
        redirect(`/volunteers/epic?error=forbidden`);
      }
      if (err instanceof EpicStateError) {
        redirect(`/volunteers/epic?error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    revalidatePath("/volunteers/epic");
    redirect("/volunteers/epic");
  }

  async function completeRequestAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("volunteers.manage_epic");
    const requestId = (formData.get("requestId") as string | null) ?? "";
    const epicId = (formData.get("epicId") as string | null) || undefined;
    try {
      await completeRequest(actor.personId, requestId, epicId);
    } catch (err) {
      if (err instanceof EpicForbiddenError) {
        redirect("/volunteers/epic?error=forbidden");
      }
      if (err instanceof EpicNotFoundError) {
        redirect("/volunteers/epic?error=not-found");
      }
      if (err instanceof EpicStateError) {
        redirect(`/volunteers/epic?error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    revalidatePath("/volunteers/epic");
  }

  async function cancelRequestAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("volunteers.manage_epic");
    const requestId = (formData.get("requestId") as string | null) ?? "";
    const reason = (formData.get("reason") as string | null) ?? "";
    try {
      await cancelRequest(actor.personId, requestId, reason);
    } catch (err) {
      if (err instanceof EpicForbiddenError) {
        redirect("/volunteers/epic?error=forbidden");
      }
      if (err instanceof EpicNotFoundError) {
        redirect("/volunteers/epic?error=not-found");
      }
      if (err instanceof EpicStateError) {
        redirect(`/volunteers/epic?error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    revalidatePath("/volunteers/epic");
  }

  async function sendEmailAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("volunteers.manage_epic");
    const requestId = (formData.get("requestId") as string | null) ?? "";
    const template = (formData.get("template") as string | null) ?? "";
    const validTemplates: EpicTemplateKey[] = [
      "epic-onboarding",
      "epic-activation",
      "epic-password-reset",
    ];
    if (!(validTemplates as string[]).includes(template)) {
      redirect("/volunteers/epic?error=invalid-template");
    }
    try {
      await sendEpicEmail(actor.personId, requestId, template as EpicTemplateKey);
    } catch (err) {
      if (err instanceof EpicForbiddenError) {
        redirect("/volunteers/epic?error=forbidden");
      }
      if (err instanceof EpicNotFoundError) {
        redirect("/volunteers/epic?error=not-found");
      }
      if (err instanceof EpicStateError) {
        redirect(`/volunteers/epic?error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    revalidatePath("/volunteers/epic");
  }

  async function createTicketAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("volunteers.manage_epic");
    const requestIds = formData.getAll("requestIds") as string[];
    const description = (formData.get("description") as string | null) || null;
    if (requestIds.length === 0) {
      redirect("/volunteers/epic?error=state-error");
    }
    try {
      await createTicket(actor.personId, { requestIds, description });
    } catch (err) {
      if (err instanceof EpicForbiddenError) {
        redirect("/volunteers/epic?error=forbidden");
      }
      if (err instanceof EpicStateError) {
        redirect(`/volunteers/epic?error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    revalidatePath("/volunteers/epic");
    redirect("/volunteers/epic?status=SUBMITTED");
  }

  async function setSrNumberAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("volunteers.manage_epic");
    const ticketId = (formData.get("ticketId") as string | null) ?? "";
    const srNumber = (formData.get("srNumber") as string | null) ?? "";
    try {
      await setTicketServiceRequestNumber(actor.personId, ticketId, srNumber);
    } catch (err) {
      if (err instanceof EpicForbiddenError) {
        redirect("/volunteers/epic?error=forbidden");
      }
      if (err instanceof EpicNotFoundError) {
        redirect("/volunteers/epic?error=not-found");
      }
      throw err;
    }
    revalidatePath("/volunteers/epic");
  }

  async function closeTicketAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("volunteers.manage_epic");
    const ticketId = (formData.get("ticketId") as string | null) ?? "";
    try {
      await closeTicket(actor.personId, ticketId);
    } catch (err) {
      if (err instanceof EpicForbiddenError) {
        redirect("/volunteers/epic?error=forbidden");
      }
      if (err instanceof EpicNotFoundError) {
        redirect("/volunteers/epic?error=not-found");
      }
      if (err instanceof EpicStateError) {
        redirect(`/volunteers/epic?error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    revalidatePath("/volunteers/epic");
  }

  async function updateDetailsAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("volunteers.manage_epic");
    const requestId = (formData.get("requestId") as string | null) ?? "";
    const jobTitle = (formData.get("jobTitle") as string | null) ?? "";
    const mirrorEpicId = (formData.get("mirrorEpicId") as string | null) ?? "";
    try {
      await updateRequestDetails(actor.personId, requestId, { jobTitle, mirrorEpicId });
    } catch (err) {
      if (err instanceof EpicForbiddenError) {
        redirect("/volunteers/epic?error=forbidden");
      }
      if (err instanceof EpicNotFoundError) {
        redirect("/volunteers/epic?error=not-found");
      }
      if (err instanceof EpicStateError) {
        redirect(`/volunteers/epic?error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    revalidatePath("/volunteers/epic");
    redirect(`/volunteers/epic?status=${statusFilter}`);
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const now = new Date();

  return (
    <div>
      <PageHeader
        title="Epic Requests"
        description="Manage Epic account requests and YNHH ticket submissions"
      />

      {errorMessage && (
        <Alert tone="error" className="mt-4">
          {errorMessage}
        </Alert>
      )}

      {/* Summary stat cards */}
      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Pending" value={counts.PENDING} tone="default" />
        <StatCard label="Submitted" value={counts.SUBMITTED} tone="warning" />
        <StatCard label="Completed" value={counts.COMPLETED} tone="success" />
        <StatCard label="Cancelled" value={counts.CANCELLED} tone="critical" />
      </div>

      {/* Status filter bar */}
      <form method="GET" action="/volunteers/epic" className="mt-6 flex flex-wrap items-end gap-3">
        <div className="w-44">
          <Field label="Status">
            <Select name="status" defaultValue={statusFilter}>
              {ALL_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Button type="submit" variant="primary" size="sm">
          Filter
        </Button>
      </form>

      {/* New request form */}
      <section className="mt-8">
        <h2 className="mb-3 text-base font-semibold">New Request</h2>
        <form action={newRequestAction} className="flex flex-wrap items-end gap-3">
          <div className="w-52">
            <Field label="NetID or email">
              <Input name="personKey" placeholder="netid or email@yale.edu" required />
            </Field>
          </div>
          <div className="w-36">
            <Field label="Kind">
              <Select name="kind" defaultValue="NEW">
                {ALL_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="w-44">
            <Field label="Job title">
              <Input name="jobTitle" placeholder="Optional" />
            </Field>
          </div>
          <div className="w-44">
            <Field label="Mirror Epic ID">
              <Input name="mirrorEpicId" placeholder="Optional" />
            </Field>
          </div>
          <div className="flex-1 min-w-44">
            <Field label="Notes">
              <Input name="notes" placeholder="Optional" />
            </Field>
          </div>
          <Button type="submit" variant="outline" size="sm">
            Create request
          </Button>
        </form>
      </section>

      {/* Request table */}
      <section className="mt-8">
        <h2 className="mb-2 text-base font-semibold">
          {STATUS_LABEL[statusFilter]} Requests
          {total > 0 && (
            <span className="ml-2 text-sm font-normal text-slate-500">({total})</span>
          )}
        </h2>

        {/* The ticket-selection form wraps the pending section.
            Individual row action forms are outside this form but their
            checkboxes use form="ticket-form" to associate with it. */}
        {statusFilter === "PENDING" && (
          <form id="ticket-form" action={createTicketAction}>
            <div className="mb-2 flex items-end gap-3">
              <div className="w-64">
                <Field label="Ticket description (optional)">
                  <Input name="description" placeholder="Optional description" />
                </Field>
              </div>
              <Button type="submit" variant="outline" size="sm">
                Submit selected to YNHH
              </Button>
            </div>
          </form>
        )}

        {rows.length === 0 ? (
          <div className="mt-12 flex flex-col items-center justify-center gap-3 text-center text-sm text-slate-500">
            <p>No {STATUS_LABEL[statusFilter].toLowerCase()} requests.</p>
          </div>
        ) : (
          <>
            <Table>
              <THead>
                <TR>
                  {statusFilter === "PENDING" && (
                    <TH>
                      <SelectAllCheckbox formId="ticket-form" />
                      <span className="sr-only">Select</span>
                    </TH>
                  )}
                  <TH>Person</TH>
                  <TH>Kind</TH>
                  <TH>Status</TH>
                  <TH>Job Title</TH>
                  <TH>Mirror Epic ID</TH>
                  <TH>Ticket SR#</TH>
                  <TH>Requested</TH>
                  <TH>Actions</TH>
                </TR>
              </THead>
              <tbody>
                {rows.map((row) => {
                  const personLogs: EmailLog[] = emailHistoryMap.get(row.person.id) ?? [];
                  const lastOnboarding = personLogs.find((l) => l.template === "epic-onboarding");
                  const lastActivation = personLogs.find((l) => l.template === "epic-activation");
                  const lastPwReset = personLogs.find((l) => l.template === "epic-password-reset");

                  const isActionable =
                    row.status === "PENDING" || row.status === "SUBMITTED";

                  return (
                    <TR key={row.id}>
                      {statusFilter === "PENDING" && (
                        <TD>
                          {/* form attribute associates this checkbox with ticket-form
                              even though it is inside a different <form> element */}
                          <Checkbox
                            name="requestIds"
                            value={row.id}
                            form="ticket-form"
                            aria-label={`Select request for ${row.person.name ?? row.person.netId}`}
                          />
                        </TD>
                      )}
                      <TD>
                        <div className="flex flex-col gap-0.5 text-sm">
                          <span className="font-medium">{row.person.name ?? "-"}</span>
                          {row.person.netId && (
                            <span className="text-slate-500 text-xs">{row.person.netId}</span>
                          )}
                          {row.person.contactEmail && (
                            <span className="text-slate-400 text-xs">{row.person.contactEmail}</span>
                          )}
                        </div>
                      </TD>
                      <TD>
                        <Badge tone="default">{row.kind}</Badge>
                      </TD>
                      <TD>
                        <Badge tone={STATUS_TONE[row.status]}>
                          {STATUS_LABEL[row.status]}
                        </Badge>
                      </TD>
                      {isActionable ? (
                        <TD colSpan={2}>
                          <form action={updateDetailsAction} className="flex flex-col gap-1">
                            <input type="hidden" name="requestId" value={row.id} />
                            <Input
                              name="jobTitle"
                              aria-label="Job title"
                              defaultValue={row.jobTitle ?? ""}
                              placeholder="Job title"
                              className="w-36 py-1 text-xs"
                            />
                            <Input
                              name="mirrorEpicId"
                              aria-label="Mirror Epic ID"
                              defaultValue={row.mirrorEpicId ?? ""}
                              placeholder="Mirror Epic ID"
                              className="w-36 py-1 text-xs font-mono"
                            />
                            <Button type="submit" variant="ghost" size="sm">
                              Save
                            </Button>
                          </form>
                        </TD>
                      ) : (
                        <>
                          <TD className="text-slate-600 text-sm">{row.jobTitle ?? "-"}</TD>
                          <TD className="text-slate-600 text-sm font-mono text-xs">
                            {row.mirrorEpicId ?? "-"}
                          </TD>
                        </>
                      )}
                      <TD className="text-slate-600 text-sm">
                        {row.ticket
                          ? row.ticket.serviceRequestNumber ?? row.ticket.id.slice(0, 8)
                          : "-"}
                      </TD>
                      <TD className="text-slate-600 tabular-nums text-sm">
                        {fmtDate(row.createdAt)}
                      </TD>
                      <TD>
                        {isActionable ? (
                          <div className="flex flex-col gap-2 min-w-[280px]">
                            {/* Complete */}
                            <form action={completeRequestAction} className="flex items-center gap-1.5">
                              <input type="hidden" name="requestId" value={row.id} />
                              {(row.kind === "NEW" || row.kind === "MODIFY") ? (
                                <>
                                  <Input
                                    name="epicId"
                                    aria-label="Epic ID"
                                    placeholder="Epic ID"
                                    className="w-28 py-1 text-xs"
                                    required
                                  />
                                  <Button type="submit" variant="outline" size="sm">
                                    Complete
                                  </Button>
                                </>
                              ) : (
                                /* RENEW: no epicId needed */
                                <ConfirmButton label="Complete" confirmLabel="Complete this renewal?" />
                              )}
                            </form>

                            {/* Cancel */}
                            <form action={cancelRequestAction} className="flex items-center gap-1.5">
                              <input type="hidden" name="requestId" value={row.id} />
                              <Input
                                name="reason"
                                aria-label="Cancellation reason"
                                placeholder="Reason"
                                className="w-28 py-1 text-xs"
                                required
                              />
                              <Button type="submit" variant="danger" size="sm">
                                Cancel
                              </Button>
                            </form>

                            {/* Email buttons */}
                            <div className="flex flex-col gap-1">
                              <div className="flex items-center gap-1.5">
                                <form action={sendEmailAction}>
                                  <input type="hidden" name="requestId" value={row.id} />
                                  <input type="hidden" name="template" value="epic-onboarding" />
                                  <ConfirmButton label="Send onboarding" confirmLabel="Confirm send?" />
                                </form>
                                <form action={sendEmailAction}>
                                  <input type="hidden" name="requestId" value={row.id} />
                                  <input type="hidden" name="template" value="epic-activation" />
                                  <ConfirmButton label="Send activation" confirmLabel="Confirm send?" />
                                </form>
                                <form action={sendEmailAction}>
                                  <input type="hidden" name="requestId" value={row.id} />
                                  <input type="hidden" name="template" value="epic-password-reset" />
                                  <ConfirmButton label="Send PW reset" confirmLabel="Confirm send?" />
                                </form>
                              </div>
                              {/* Last-send info */}
                              <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                                {lastOnboarding && (
                                  <span className="text-[11px] text-slate-400">
                                    onboarding {lastOnboarding.status.toLowerCase()} {fmtDate(lastOnboarding.createdAt)}
                                  </span>
                                )}
                                {lastActivation && (
                                  <span className="text-[11px] text-slate-400">
                                    activation {lastActivation.status.toLowerCase()} {fmtDate(lastActivation.createdAt)}
                                  </span>
                                )}
                                {lastPwReset && (
                                  <span className="text-[11px] text-slate-400">
                                    pw-reset {lastPwReset.status.toLowerCase()} {fmtDate(lastPwReset.createdAt)}
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>
                        ) : (
                          <span className="text-xs text-slate-400">-</span>
                        )}
                      </TD>
                    </TR>
                  );
                })}
              </tbody>
            </Table>

            <div className="mt-4">
              <Pagination page={page} pageCount={pageCount} hrefFor={buildHref} />
            </div>
          </>
        )}
      </section>

      {/* YNHH Tickets */}
      <section className="mt-12">
        <h2 className="mb-3 text-base font-semibold">YNHH Tickets</h2>

        {tickets.length === 0 ? (
          <div className="mt-12 flex flex-col items-center justify-center gap-3 text-center text-sm text-slate-500">
            <p>No tickets yet.</p>
          </div>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>SR #</TH>
                <TH>Description</TH>
                <TH>Submitted by / at</TH>
                <TH>Age (biz days)</TH>
                <TH>Requests</TH>
                <TH>Status</TH>
                <TH><span className="sr-only">Actions</span></TH>
              </TR>
            </THead>
            <tbody>
              {tickets.map((ticket) => {
                const isOpen = ticket.status === "OPEN";
                const ageDays = isOpen ? businessDaysSince(ticket.submittedAt, now) : null;

                return (
                  <TR key={ticket.id}>
                    <TD>
                      <form action={setSrNumberAction} className="flex items-center gap-1.5">
                        <input type="hidden" name="ticketId" value={ticket.id} />
                        <Input
                          name="srNumber"
                          aria-label="SR number"
                          defaultValue={ticket.serviceRequestNumber ?? ""}
                          placeholder="SR-"
                          className="w-28 py-1 text-xs"
                        />
                        <Button type="submit" variant="ghost" size="sm">
                          Save
                        </Button>
                      </form>
                    </TD>
                    <TD
                      className="text-slate-600 text-sm max-w-xs truncate"
                      title={ticket.description ?? undefined}
                    >
                      {ticket.description ?? "-"}
                    </TD>
                    <TD>
                      <div className="flex flex-col gap-0.5 text-xs text-slate-500">
                        <span>{ticket.submittedBy.name ?? "-"}</span>
                        <span className="tabular-nums">{fmtDate(ticket.submittedAt)}</span>
                      </div>
                    </TD>
                    <TD className="tabular-nums text-sm text-slate-600">
                      {ageDays !== null ? ageDays : "-"}
                    </TD>
                    <TD className="tabular-nums text-sm text-slate-600">
                      {ticket._count.requests}
                    </TD>
                    <TD>
                      <Badge tone={isOpen ? "warning" : "default"}>
                        {isOpen ? "Open" : "Closed"}
                      </Badge>
                    </TD>
                    <TD>
                      {isOpen && (
                        <form action={closeTicketAction}>
                          <input type="hidden" name="ticketId" value={ticket.id} />
                          <ConfirmButton label="Close" confirmLabel="Close this ticket?" />
                        </form>
                      )}
                    </TD>
                  </TR>
                );
              })}
            </tbody>
          </Table>
        )}
      </section>
    </div>
  );
}
