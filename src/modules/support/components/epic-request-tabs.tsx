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
import { FormActions } from "@/platform/ui/form";
import { SectionHeader } from "@/platform/ui/section-header";
import { SUPPORT_UPLOAD_ACCEPT } from "@/modules/support/upload-constants";
import type {
  DepartmentWithMembers,
  EpicAuthorizer,
  EpicRequestHistoryRow,
  LinkableTechRequest,
  PendingDeactivation,
  PendingEpicRequestRow,
} from "@/modules/support/services/itcm";
import { Combobox, type ComboboxOption } from "@/platform/ui/combobox";
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
  /** Cap the server applied to the closed-ticket page, if any. */
  historyLimit?: number;
  pendingDeactivations: PendingDeactivation[];
  authorizers: EpicAuthorizer[];
  incidentPeople: IncidentPerson[];
  pending: PendingEpicRequestRow[];
  /** Open support tickets an Epic request can be attached to, for the Tracker's picker. */
  linkableTickets: LinkableTechRequest[];
  rollup: EpicRollup | null;
  termOptions: TermOption[];
  liveTermId: string | null;
  /**
   * "Now", stamped once on the server, for the Tracker's business-days-open
   * count. A render-body `new Date()` would be read once during SSR and again
   * at hydration, so a render straddling a clinic-local midnight would produce
   * a different count on each side and force React into a recovery re-render
   * (see router-hook-crash.ts for why that is worth avoiding here).
   */
  nowIso: string;
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
}: {
  incidentPeople: IncidentPerson[];
  logIncidentAction: (formData: FormData) => Promise<void>;
}) {
  return (
    <form action={logIncidentAction}>
      <Card className="space-y-5">
        <SectionHeader level="title">Log a YNHH incident</SectionHeader>
        <p className="text-xs text-subtle-foreground">
          For a one-off email or ticket sent to YNHH IT that isn&apos;t an Epic access request, e.g. a general
          outage report or a one-off account question.
        </p>

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
          <span className="text-critical-foreground" aria-hidden="true"> *</span>
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
  nowIso,
  linkableTickets,
  closeTicketAction,
  updateServiceRequestNumberAction,
  resolveIncidentAction,
  completeEpicRequestAction,
  sendEpicEmailFromTrackerAction,
  linkEpicRequestAction,
  cancelEpicRequestAction,
}: {
  // Never capped: the Tracker renders OPEN tickets, which are bounded by the
  // work in flight rather than by the size of the archive, so there is nothing
  // to truncate and nothing to disclose. Only HistoryTable takes a limit.
  history: EpicRequestHistoryRow[];
  nowIso: string;
  linkableTickets: LinkableTechRequest[];
  closeTicketAction: (ticketId: string) => Promise<void>;
  updateServiceRequestNumberAction: (ticketId: string, value: string) => Promise<void>;
  resolveIncidentAction: (ticketId: string, resolution: string) => Promise<void>;
  completeEpicRequestAction: (formData: FormData) => Promise<void>;
  sendEpicEmailFromTrackerAction: (formData: FormData) => Promise<void>;
  linkEpicRequestAction: (formData: FormData) => Promise<void>;
  cancelEpicRequestAction: (formData: FormData) => Promise<void>;
}) {
  const zone = useTimeZone();
  const now = new Date(nowIso);
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
        const days = businessDaysSince(new Date(ticket.submittedAt), now, zone);
        return (
          <Card key={ticket.id} className="space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-1">
                <p className="text-sm font-semibold text-foreground">
                  {ticket.subject ?? ticket.description ?? "Epic request"}
                </p>
                <p className="text-xs text-muted-foreground">
                  Submitted {formatDateOnly(new Date(ticket.submittedAt), zone)} by {ticket.submittedBy.name}
                  <span className={`ml-2 font-medium ${days > 5 ? "text-critical-foreground" : "text-warning-foreground"}`}>
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
                            {/* Prefilled on a MODIFY: that request changes someone's
                                ACCESS, not their Epic ID, so the value coming back
                                from YNHH is the one already on the record. Blank on a
                                NEW, where YNHH issues the ID and there is nothing to
                                prefill from. */}
                            <Input
                              name="epicId"
                              aria-label="Epic ID"
                              placeholder="Epic ID"
                              defaultValue={r.kind === "MODIFY" ? r.person.epicId ?? "" : ""}
                              className="w-32"
                              required
                            />
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
                      // Only while the request is still live. Offering "link to a
                      // support ticket" beside a COMPLETED request invited a
                      // pointless write and read as unfinished work.
                      (r.status === "PENDING" || r.status === "SUBMITTED") && (
                        <LinkTicketControl
                          requestId={r.id}
                          tickets={linkableTickets}
                          action={linkEpicRequestAction}
                        />
                      )
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
// Link-to-support-ticket control
// ---------------------------------------------------------------------------

/**
 * Attaches an Epic request to an open support ticket, by picking one.
 *
 * This replaced a bare number box. Typing the number meant knowing it from
 * memory or from another tab, and a wrong one either bounced with "No support
 * ticket #N found" or -- worse, and silently -- attached the Epic request to a
 * real but unrelated ticket, which nothing downstream can detect because the
 * number is a valid identifier either way. The picker only ever offers tickets
 * the link would actually succeed against.
 *
 * The option VALUE is still the ticket number, not its id, so the service
 * (linkEpicRequestToTicket) is unchanged and keeps its own "no such ticket"
 * guard for a list that went stale while the page sat open.
 */
function LinkTicketControl({
  requestId,
  tickets,
  action,
}: {
  requestId: string;
  tickets: LinkableTechRequest[];
  action: (formData: FormData) => Promise<void>;
}) {
  const [picked, setPicked] = useState("");

  if (tickets.length === 0) {
    return (
      <span className="text-xs text-subtle-foreground">No open support ticket to link</span>
    );
  }

  const options: ComboboxOption[] = tickets.map((t) => ({
    value: String(t.number),
    // Number first: it is what someone arriving from Intercom or an email has
    // in hand, and what makes the option findable by typing.
    label: `#${t.number} · ${t.subject} · ${t.requesterName}`,
  }));

  return (
    <form action={action} className="flex items-center gap-1">
      <input type="hidden" name="requestId" value={requestId} />
      <div className="w-64">
        <Combobox
          name="ticketNumber"
          options={options}
          placeholder="Link to support ticket…"
          ariaLabel="Link to a support ticket"
          emptyLabel="No matching open ticket"
          onValueChange={setPicked}
        />
      </div>
      {/* Disabled until something is actually chosen: the combobox clears its
          value when the text is edited after a selection, so an enabled button
          beside filled-looking text would post nothing and bounce. */}
      <SubmitButton size="sm" variant="ghost" pendingLabel="Linking…" disabled={!picked}>
        Link
      </SubmitButton>
    </form>
  );
}

// ---------------------------------------------------------------------------
// History table
// ---------------------------------------------------------------------------

/**
 * `historyLimit` is the cap the server applied, or undefined when it returned
 * everything. Passed in rather than imported so this component keeps no opinion
 * about how much the loader fetched; it only needs to know whether to say the
 * list is partial. A capped table that reads exactly like a complete one is the
 * thing to avoid: the archive only grows, so "no rows before 2024" would
 * otherwise look like a data problem rather than a page size.
 */
function HistoryTable({
  history,
  historyLimit,
}: {
  history: EpicRequestHistoryRow[];
  /** Cap the server applied to the closed-ticket page, if any. */
  historyLimit?: number;
}) {
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

  // Equality, not >=: the loader takes at most `historyLimit`, so a full page is
  // the only signal available that more exist behind it.
  const capped = historyLimit !== undefined && closedTickets.length === historyLimit;

  const groups = new Map<string, EpicRequestHistoryRow[]>();
  for (const row of closedTickets) {
    const key = formatDateOnly(new Date(row.ticket.closedAt ?? row.ticket.submittedAt), zone, { month: "long", year: "numeric" });
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }

  return (
    <div className="space-y-8">
      {capped && (
        <p className="text-xs text-muted-foreground">
          Showing the {historyLimit} most recently closed requests. Older ones are still
          recorded and reachable from the person they belong to.
        </p>
      )}
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
}: {
  pending: PendingEpicRequestRow[];
  action: (formData: FormData) => Promise<void>;
  cancelAction: (formData: FormData) => Promise<void>;
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
        {/* Usually blank, and that is fine: YNHH IT issues the RITM once they
            pick the work up, so it is normally added from the Tracker later.
            Offered here for the case where the ticket was raised with YNHH
            first, which is the only way the note posted into the linked
            Intercom conversation can carry a real number instead of
            "no SR# on file yet". */}
        <Field
          label="YNHH service request number (optional)"
          hint="Only if YNHH has already given you one. Otherwise add it from the Tracker when it arrives."
        >
          <Input name="serviceRequestNumber" placeholder="e.g. RITM0345759" className="w-72" />
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
  historyLimit,
  pendingDeactivations,
  authorizers,
  incidentPeople,
  pending,
  linkableTickets,
  rollup,
  termOptions,
  liveTermId,
  nowIso,
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
        <PendingTab pending={pending} action={createTicketFromPendingAction} cancelAction={cancelEpicRequestAction} />
      ) : activeTab === "tracker" ? (
        <div className="space-y-8">
          <LogIncidentForm incidentPeople={incidentPeople} logIncidentAction={logIncidentAction} />
          <TrackerTable
            history={history}
            nowIso={nowIso}
            linkableTickets={linkableTickets}
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
        <HistoryTable history={history} historyLimit={historyLimit} />
      )}
    </div>
  );
}