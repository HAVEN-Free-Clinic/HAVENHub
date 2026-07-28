"use client";

/**
 * EpicRequestTabs: top-level tab switcher for the Epic Requests page.
 *
 * Renders three tabs:
 *   - Generate: the PDF/spreadsheet/email generator form.
 *   - Tracker: a table of all open YNHH tickets (Epic-batch and standalone
 *     incidents alike) with business days since submission, ticket status,
 *     and service request number, plus the "log a YNHH incident" form for
 *     one-off tickets that aren't Epic access requests.
 *   - History: closed tickets, grouped by month.
 *
 * A ticket is an INCIDENT when ticket.subject is set (requests is empty);
 * it's an Epic-batch ticket when subject is null (one or more requests).
 * Both tables branch on that to render the right presentation per row.
 *
 * Tab state is reflected in the URL (?tab=generate or ?tab=tracker) so
 * the active tab survives a page refresh and is shareable.
 */

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { EpicRequestForm } from "./epic-request-form";
import { businessDaysSince, formatDateOnly } from "@/platform/dates";
import { useTimeZone } from "@/platform/dates/client";
import { Badge } from "@/platform/ui/badge";
import { Button } from "@/platform/ui/button";
import { Card } from "@/platform/ui/card";
import { Input, Textarea, Field } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { SubmitButton } from "@/platform/ui/submit-button";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { TabRow, type TabItem } from "@/platform/ui/tab-row";
import { EPIC_KIND_LABELS, EPIC_STATUS_LABELS, EPIC_STATUS_TONE } from "@/modules/support/labels";
import type { EpicRequestStatus } from "@prisma/client";
import { Alert } from "@/platform/ui/alert";
import { FormActions } from "@/platform/ui/form";
import { SectionHeader } from "@/platform/ui/section-header";
import { SUPPORT_UPLOAD_ACCEPT } from "@/modules/support/upload-constants";
import type {
  DepartmentWithMembers,
  EpicAuthorizer,
  EpicRequestHistoryRow,
  PendingDeactivation,
  PendingEpicRequestRow,
} from "@/modules/support/services/itcm";
import { Checkbox } from "@/platform/ui/checkbox";
import { TicketNumberField } from "./ticket-number-field";
import { TermBatchTab } from "./term-batch-tab";
import type { EpicRollup } from "@/modules/support/services/epic-rollup";
import type { TermOption } from "@/platform/terms/term-options";

type Tab = "generate" | "term-batch" | "pending" | "tracker" | "history";

type IncidentPerson = { id: string; name: string };

type Props = {
  activeTab: Tab;
  departments: DepartmentWithMembers[];
  history: EpicRequestHistoryRow[];
  pendingDeactivations: PendingDeactivation[];
  authorizers: EpicAuthorizer[];
  incidentPeople: IncidentPerson[];
  pending: PendingEpicRequestRow[];
  rollup: EpicRollup | null;
  termOptions: TermOption[];
  liveTermId: string | null;
  /** Tracker/Pending row-action failures (complete, link, cancel, resolve, ...). */
  error?: string;
  /** Failures from the "Log a YNHH incident" form only (#115). */
  incidentError?: string;
  closeTicketAction: (ticketId: string) => Promise<void>;
  updateServiceRequestNumberAction: (ticketId: string, value: string) => Promise<void>;
  logIncidentAction: (formData: FormData) => Promise<void>;
  resolveIncidentAction: (ticketId: string, resolution: string) => Promise<void>;
  createTicketFromPendingAction: (formData: FormData) => Promise<void>;
  completeEpicRequestAction: (formData: FormData) => Promise<void>;
  sendEpicEmailFromTrackerAction: (formData: FormData) => Promise<void>;
  linkEpicRequestAction: (formData: FormData) => Promise<void>;
  cancelEpicRequestAction: (formData: FormData) => Promise<void>;
};

// ---------------------------------------------------------------------------
// Tab nav (client -- uses router for URL updates)
// ---------------------------------------------------------------------------

function TabNav({ activeTab }: { activeTab: Tab }) {
  const searchParams = useSearchParams();

  function hrefFor(tab: Tab): string {
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", tab);
    return `?${params.toString()}`;
  }

  const labels: Record<Tab, string> = {
    generate: "Generate",
    "term-batch": "Term batch",
    pending: "Pending",
    tracker: "Tracker",
    history: "History",
  };

  const items: TabItem[] = (["generate", "term-batch", "pending", "tracker", "history"] as Tab[]).map((tab) => ({
    label: labels[tab],
    href: hrefFor(tab),
  }));

  // Matches the existing tab by re-parsing its own href's "tab" param, so this
  // stays correct even if two tabs ever shared a label; compares against the
  // activeTab prop the component already receives rather than the pathname,
  // since every Epic tab lives at the same path and differs only by ?tab=.
  function isActive(item: TabItem): boolean {
    const [, query = ""] = item.href.split("?");
    return new URLSearchParams(query).get("tab") === activeTab;
  }

  return <TabRow variant="underline" label="Epic sections" items={items} isActive={isActive} />;
}

// ---------------------------------------------------------------------------
// Log a YNHH incident (Tracker tab)
// ---------------------------------------------------------------------------

function LogIncidentForm({
  incidentPeople,
  logIncidentAction,
  error,
}: {
  incidentPeople: IncidentPerson[];
  logIncidentAction: (formData: FormData) => Promise<void>;
  error?: string;
}) {
  return (
    <form action={logIncidentAction}>
      <Card className="space-y-5">
        <SectionHeader level="title">Log a YNHH incident</SectionHeader>
        <p className="text-xs text-subtle-foreground">
          For a one-off email or ticket sent to YNHH IT that isn&apos;t an Epic access request, e.g. a general
          outage report or a one-off account question.
        </p>

        {error && <Alert tone="error">{error}</Alert>}

        <Field label="Subject" required>
          <Input name="subject" placeholder="Short summary of the incident" required maxLength={200} />
        </Field>

        <Field label="Description">
          <Textarea name="description" rows={4} placeholder="Details, optional" />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="YNHH service request #">
            <Input name="serviceRequestNumber" placeholder="e.g. RITM1234567" />
          </Field>

          <Field label="Person">
            <Select name="personId" defaultValue="">
              <option value="">Not person-specific</option>
              {incidentPeople.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field label="Attachments" hint="Optional. Images, PDF, text, or Office documents.">
          {/* eslint-disable-next-line no-restricted-syntax -- native file input with file-button pseudo-element styling (file:* classes); no file primitive exists */}
          <input type="file" name="attachments" multiple accept={SUPPORT_UPLOAD_ACCEPT} className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-muted file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-foreground-soft hover:file:bg-muted-strong" />
        </Field>

        <FormActions>
          <SubmitButton variant="primary" pendingLabel="Logging…">
            Log incident
          </SubmitButton>
        </FormActions>
      </Card>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Resolve action (inline, for INCIDENT rows in the Tracker)
// ---------------------------------------------------------------------------

function IncidentResolveAction({
  ticketId,
  resolveIncidentAction,
}: {
  ticketId: string;
  resolveIncidentAction: (ticketId: string, resolution: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);

  async function handleResolve(formData: FormData) {
    const resolution = (formData.get("resolution") as string) ?? "";
    await resolveIncidentAction(ticketId, resolution);
    setOpen(false);
  }

  if (!open) {
    return (
      <Button type="button" size="sm" onClick={() => setOpen(true)}>
        Resolve
      </Button>
    );
  }

  return (
    <form action={handleResolve} className="flex w-full flex-col gap-2 sm:w-64">
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">
          Resolution
          <span className="text-critical" aria-hidden="true"> *</span>
        </span>
        <Textarea name="resolution" rows={2} required placeholder="What resolved this incident?" className="text-xs" />
      </label>
      <div className="flex items-center gap-2">
        <SubmitButton size="sm" variant="primary" pendingLabel="Resolving…">
          Resolve
        </SubmitButton>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Shared incident row body (Tracker + History)
// ---------------------------------------------------------------------------

function IncidentBody({ row }: { row: EpicRequestHistoryRow }) {
  const { ticket, about, attachments } = row;
  return (
    <>
      <p className="text-xs text-foreground-soft">
        Person: <span className="font-medium">{about?.name ?? "Not person-specific"}</span>
      </p>
      {ticket.description && <p className="text-sm text-foreground-soft">{ticket.description}</p>}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {attachments.map((a) => (
            <a
              key={a.id}
              href={`/support/attachment/${a.id}`}
              className="text-xs text-brand-fg underline underline-offset-2 hover:text-brand-hover"
            >
              {a.filename}
            </a>
          ))}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Tracker table
// ---------------------------------------------------------------------------

function TrackerTable({
  history,
  closeTicketAction,
  updateServiceRequestNumberAction,
  resolveIncidentAction,
  completeEpicRequestAction,
  sendEpicEmailFromTrackerAction,
  linkEpicRequestAction,
  cancelEpicRequestAction,
}: {
  history: EpicRequestHistoryRow[];
  closeTicketAction: (ticketId: string) => Promise<void>;
  updateServiceRequestNumberAction: (ticketId: string, value: string) => Promise<void>;
  resolveIncidentAction: (ticketId: string, resolution: string) => Promise<void>;
  completeEpicRequestAction: (formData: FormData) => Promise<void>;
  sendEpicEmailFromTrackerAction: (formData: FormData) => Promise<void>;
  linkEpicRequestAction: (formData: FormData) => Promise<void>;
  cancelEpicRequestAction: (formData: FormData) => Promise<void>;
}) {
  const zone = useTimeZone();
  const openTickets = history.filter((h) => h.ticket.status === "OPEN");

  if (openTickets.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No open Epic requests. Generate a PDF to get started.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {openTickets.map((row) => {
        const { ticket, requests } = row;
        const isIncident = Boolean(ticket.subject);
        const days = businessDaysSince(new Date(ticket.submittedAt), new Date(), zone);
        return (
          <Card key={ticket.id} className="space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-1">
                <p className="text-sm font-semibold text-foreground">
                  {ticket.subject ?? ticket.description ?? "Epic request"}
                </p>
                <p className="text-xs text-muted-foreground">
                  Submitted {formatDateOnly(new Date(ticket.submittedAt), zone)} by {ticket.submittedBy.name}
                  <span className={`ml-2 font-medium ${days > 5 ? "text-critical" : "text-warning-foreground"}`}>
                    · {days} business day{days !== 1 ? "s" : ""} open
                  </span>
                </p>
                <TicketNumberField
                  ticketId={ticket.id}
                  serviceRequestNumber={ticket.serviceRequestNumber}
                  updateAction={updateServiceRequestNumberAction}
                />
                {isIncident && <IncidentBody row={row} />}
              </div>
              <div className="flex items-center gap-2">
                <Badge tone="warning">Open</Badge>
                {isIncident ? (
                  <IncidentResolveAction ticketId={ticket.id} resolveIncidentAction={resolveIncidentAction} />
                ) : (
                  <form
                    action={async () => {
                      await closeTicketAction(ticket.id);
                    }}
                  >
                    <SubmitButton size="sm" pendingLabel="Completing…">
                      Mark complete
                    </SubmitButton>
                  </form>
                )}
              </div>
            </div>

            {!isIncident && (
              <div className="space-y-2">
                {requests.map((r) => (
                  <div key={r.id} className="flex flex-wrap items-center gap-2 text-xs text-foreground-soft">
                    <Badge>{EPIC_KIND_LABELS[r.kind]}</Badge>
                    <span>{r.person.name}</span>
                    {r.person.epicId && (
                      <span className="text-subtle-foreground">{r.person.epicId}</span>
                    )}
                    <Badge tone={EPIC_STATUS_TONE[r.status as EpicRequestStatus]}>{EPIC_STATUS_LABELS[r.status as EpicRequestStatus]}</Badge>

                    {(r.status === "PENDING" || r.status === "SUBMITTED") && (
                      <form action={completeEpicRequestAction} className="flex items-center gap-1">
                        <input type="hidden" name="requestId" value={r.id} />
                        {r.kind === "NEW" || r.kind === "MODIFY" ? (
                          <>
                            <Input name="epicId" aria-label="Epic ID" placeholder="Epic ID" className="w-32" required />
                            <SubmitButton size="sm" variant="outline" pendingLabel="Completing…">
                              Complete
                            </SubmitButton>
                          </>
                        ) : (
                          <SubmitButton size="sm" variant="outline" pendingLabel="Completing…">
                            Complete
                          </SubmitButton>
                        )}
                      </form>
                    )}

                    {(r.status === "PENDING" || r.status === "SUBMITTED") && (
                      <form action={cancelEpicRequestAction}>
                        <input type="hidden" name="requestId" value={r.id} />
                        <input type="hidden" name="tab" value="tracker" />
                        <SubmitButton size="sm" variant="ghost" pendingLabel="Cancelling…">
                          Cancel
                        </SubmitButton>
                      </form>
                    )}

                    {(r.status === "PENDING" || r.status === "SUBMITTED" || r.status === "COMPLETED") && r.kind !== "DEACTIVATE" && (
                      <div className="flex flex-wrap gap-1">
                        {/* Onboarding / activation / password-reset templates model NEW/MODIFY/RENEW
                            access requests, not a DEACTIVATE, whose email would send an
                            access-instructions message to a person being offboarded. */}
                        {(["epic-onboarding", "epic-activation", "epic-password-reset"] as const).map((tpl) => {
                          // Three look-alike buttons that each send a real email to the
                          // volunteer on one click. Arm-then-confirm so a misclick can't
                          // fire the wrong template at a real person, and the confirm
                          // names which email is about to go out.
                          const emailLabel =
                            tpl === "epic-onboarding" ? "Onboarding" : tpl === "epic-activation" ? "Activation" : "Password reset";
                          return (
                            <form key={tpl} action={sendEpicEmailFromTrackerAction}>
                              <input type="hidden" name="requestId" value={r.id} />
                              <input type="hidden" name="template" value={tpl} />
                              <ConfirmButton size="sm" label={emailLabel} confirmLabel={`Send ${emailLabel} email?`} />
                            </form>
                          );
                        })}
                      </div>
                    )}

                    {r.techRequest ? (
                      <Link
                        href={`/support/${r.techRequest.id}`}
                        className="text-xs text-brand-fg underline underline-offset-2"
                      >
                        Support #{r.techRequest.number}
                      </Link>
                    ) : (
                      <form action={linkEpicRequestAction} className="flex items-center gap-1">
                        <input type="hidden" name="requestId" value={r.id} />
                        <Input
                          name="ticketNumber"
                          type="number"
                          min={1}
                          placeholder="Ticket #"
                          aria-label="Link to support ticket number"
                          className="w-24"
                        />
                        <SubmitButton size="sm" variant="ghost" pendingLabel="Linking…">
                          Link
                        </SubmitButton>
                      </form>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}


// ---------------------------------------------------------------------------
// History table
// ---------------------------------------------------------------------------

function HistoryTable({ history }: { history: EpicRequestHistoryRow[] }) {
  const zone = useTimeZone();
  // getEpicRequestHistory returns rows by submittedAt desc, but the History tab
  // groups by CLOSED month and relies on Map insertion order for both the month
  // headings and the rows within each. Re-sort by closedAt (fall back to
  // submittedAt) desc so a ticket submitted earlier but closed later doesn't push
  // its month above a newer one -- otherwise months render out of chronological
  // order, contradicting every other newest-first list in the module (#116).
  const closedTickets = history
    .filter((h) => h.ticket.status === "CLOSED")
    .sort(
      (a, b) =>
        new Date(b.ticket.closedAt ?? b.ticket.submittedAt).getTime() -
        new Date(a.ticket.closedAt ?? a.ticket.submittedAt).getTime(),
    );

  if (closedTickets.length === 0) {
    return <p className="text-sm text-muted-foreground">No completed Epic requests yet.</p>;
  }

  const groups = new Map<string, EpicRequestHistoryRow[]>();
  for (const row of closedTickets) {
    const key = formatDateOnly(new Date(row.ticket.closedAt ?? row.ticket.submittedAt), zone, { month: "long", year: "numeric" });
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }

  return (
    <div className="space-y-8">
      {[...groups.entries()].map(([month, rows]) => (
        <div key={month}>
          <h2 className="text-sm font-semibold text-foreground mb-3">{month}</h2>
          <div className="space-y-4">
            {rows.map((row) => {
              const { ticket, requests } = row;
              const isIncident = Boolean(ticket.subject);
              return (
                <Card key={ticket.id} className="space-y-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-1">
                      <p className="text-sm font-semibold text-foreground">{ticket.subject ?? ticket.description ?? "Epic request"}</p>
                      <p className="text-xs text-muted-foreground">
                        Submitted {formatDateOnly(new Date(ticket.submittedAt), zone)} by {ticket.submittedBy.name}
                        {ticket.closedAt && <span className="ml-2">· Closed {formatDateOnly(new Date(ticket.closedAt), zone)}</span>}
                      </p>
                      {ticket.serviceRequestNumber && (
                        <p className="text-xs text-muted-foreground">
                          Service request: <span className="font-medium text-foreground-soft">{ticket.serviceRequestNumber}</span>
                        </p>
                      )}
                      {isIncident && <IncidentBody row={row} />}
                      {isIncident && ticket.resolution && (
                        <p className="text-xs text-foreground-soft">
                          Resolution: <span className="font-medium">{ticket.resolution}</span>
                        </p>
                      )}
                    </div>
                    <Badge tone="success">Closed</Badge>
                  </div>
                  {!isIncident && (
                    <div className="space-y-1">
                      {requests.map((r) => (
                        <div key={r.id} className="flex items-center gap-2 text-xs text-foreground-soft">
                          <Badge>{EPIC_KIND_LABELS[r.kind]}</Badge>
                          <span>{r.person.name}</span>
                          {r.person.epicId && <span className="text-subtle-foreground">{r.person.epicId}</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pending tab -- attached (un-submitted) Epic requests, batched into a ticket
// ---------------------------------------------------------------------------

function PendingTab({
  pending,
  action,
  cancelAction,
  error,
}: {
  pending: PendingEpicRequestRow[];
  action: (formData: FormData) => Promise<void>;
  cancelAction: (formData: FormData) => Promise<void>;
  error?: string;
}) {
  if (pending.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No pending Epic requests. Attach some from a support ticket, or promote a volunteer who needs Epic access.
      </p>
    );
  }
  return (
    <form action={action} className="space-y-4">
      <Card className="space-y-3">
        <SectionHeader level="title">Pending Epic requests</SectionHeader>
        <p className="text-xs text-subtle-foreground">
          Select requests and open one YNHH ticket for them. They then appear under Tracker.
        </p>

        {error && <Alert tone="error">{error}</Alert>}

        {/* tab=pending is read by cancelEpicRequestAction so a per-row cancel
            (formAction below) redirects back to this tab. */}
        <input type="hidden" name="tab" value="pending" />
        <ul className="space-y-1">
          {pending.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-2 text-sm">
              <Checkbox name="requestIds" value={r.id} />
              <Badge>{EPIC_KIND_LABELS[r.kind]}</Badge>
              <span className="font-medium">{r.person.name}</span>
              {r.techRequest ? (
                <Link href={`/support/${r.techRequest.id}`} className="text-xs text-brand-fg underline underline-offset-2">
                  #{r.techRequest.number}
                </Link>
              ) : (
                <span className="text-xs text-subtle-foreground">Promotion</span>
              )}
              {r.notes && <span className="text-xs text-subtle-foreground">· {r.notes}</span>}
              {/* Discard a stale pending request (e.g. a promotion-origin one for
                  someone who already has an Epic ID or withdrew). formAction
                  submits this row's id to the cancel action within the same form,
                  so it needs no nested form. Only the clicked button's requestId
                  enters the FormData, so it does not interfere with the create
                  checkboxes above. */}
              <SubmitButton
                size="sm"
                variant="ghost"
                pendingLabel="Cancelling…"
                formAction={cancelAction}
                name="requestId"
                value={r.id}
                className="ml-auto"
              >
                Cancel
              </SubmitButton>
            </li>
          ))}
        </ul>
        <Field label="YNHH ticket description (optional)">
          <Input name="description" placeholder="Optional" className="w-72" />
        </Field>
        <FormActions>
          <SubmitButton variant="primary" pendingLabel="Creating…">
            Create YNHH ticket
          </SubmitButton>
        </FormActions>
      </Card>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function EpicRequestTabs({
  activeTab,
  departments,
  history,
  pendingDeactivations,
  authorizers,
  incidentPeople,
  pending,
  rollup,
  termOptions,
  liveTermId,
  error,
  incidentError,
  closeTicketAction,
  updateServiceRequestNumberAction,
  logIncidentAction,
  resolveIncidentAction,
  createTicketFromPendingAction,
  completeEpicRequestAction,
  sendEpicEmailFromTrackerAction,
  linkEpicRequestAction,
  cancelEpicRequestAction,
}: Props) {
  return (
    // space-y-8 restores the separation TabRow's underline variant deliberately
    // omits (ModuleNav callers add it via a wrapping div around children instead,
    // but TabNav and the tab content below are siblings in this component, not a
    // layout/children split, so the gap is applied here on the shared root).
    <div className="space-y-8">
      <Suspense>
        <TabNav activeTab={activeTab} />
      </Suspense>
      {activeTab === "generate" ? (
        <EpicRequestForm departments={departments} pendingDeactivations={pendingDeactivations} authorizers={authorizers} />
      ) : activeTab === "term-batch" ? (
        rollup ? (
          <TermBatchTab
            key={rollup.term.id}
            rollup={rollup}
            authorizers={authorizers}
            termOptions={termOptions}
            liveTermId={liveTermId}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            No term is active yet. Activate a term, or create one in planning, to build a batch.
          </p>
        )
      ) : activeTab === "pending" ? (
        <PendingTab pending={pending} action={createTicketFromPendingAction} cancelAction={cancelEpicRequestAction} error={error} />
      ) : activeTab === "tracker" ? (
        <div className="space-y-8">
          <LogIncidentForm incidentPeople={incidentPeople} logIncidentAction={logIncidentAction} error={incidentError} />
          {/* Tracker ROW-action errors (complete, link, cancel, resolve, SR number)
              belong with the table, not inside the incident form above (#115). */}
          {error && <Alert tone="error">{error}</Alert>}
          <TrackerTable
            history={history}
            closeTicketAction={closeTicketAction}
            updateServiceRequestNumberAction={updateServiceRequestNumberAction}
            resolveIncidentAction={resolveIncidentAction}
            completeEpicRequestAction={completeEpicRequestAction}
            sendEpicEmailFromTrackerAction={sendEpicEmailFromTrackerAction}
            linkEpicRequestAction={linkEpicRequestAction}
            cancelEpicRequestAction={cancelEpicRequestAction}
          />
        </div>
      ) : (
        <HistoryTable history={history} />
      )}
    </div>
  );
}