"use client";

/**
 * EpicRequestTabs: top-level tab switcher for the Epic Requests page.
 *
 * Renders two tabs:
 *   - Generate: the PDF/spreadsheet/email generator form.
 *   - Tracker: a table of all submitted YNHH tickets with business days
 *     since submission, ticket status, and service request number.
 *
 * Tab state is reflected in the URL (?tab=generate or ?tab=tracker) so
 * the active tab survives a page refresh and is shareable.
 */

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { EpicRequestForm } from "./epic-request-form";
import { businessDaysSince } from "@/platform/dates";
import { Badge } from "@/platform/ui/badge";
import { Card } from "@/platform/ui/card";
import type { DepartmentWithMembers, EpicRequestHistoryRow, PendingDeactivation } from "@/modules/admin/services/itcm";
import { TicketNumberField } from "./ticket-number-field";

type Tab = "generate" | "tracker" | "history";

type Props = {
  activeTab: Tab;
  departments: DepartmentWithMembers[];
  history: EpicRequestHistoryRow[];
  pendingDeactivations: PendingDeactivation[];
  closeTicketAction: (ticketId: string) => Promise<void>;
  updateServiceRequestNumberAction: (ticketId: string, value: string) => Promise<void>;
};

// ---------------------------------------------------------------------------
// Tab nav (client -- uses router for URL updates)
// ---------------------------------------------------------------------------

function TabNav({ activeTab }: { activeTab: Tab }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function goTo(tab: Tab) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", tab);
    router.push(`?${params.toString()}`);
  }

  const labels: Record<Tab, string> = { generate: "Generate", tracker: "Tracker", history: "History" };

  return (
    <div className="flex gap-4 border-b border-border mb-8">
      {(["generate", "tracker", "history"] as Tab[]).map((tab) => (
        <button
          key={tab}
          onClick={() => goTo(tab)}
          className={`pb-3 text-sm font-semibold border-b-2 transition-colors ${
            activeTab === tab
              ? "border-brand text-brand-fg"
              : "border-transparent text-muted-foreground hover:text-foreground-soft"
          }`}
        >
          {labels[tab]}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tracker table
// ---------------------------------------------------------------------------

function TrackerTable({
  history,
  closeTicketAction,
  updateServiceRequestNumberAction,
}: {
  history: EpicRequestHistoryRow[];
  closeTicketAction: (ticketId: string) => Promise<void>;
  updateServiceRequestNumberAction: (ticketId: string, value: string) => Promise<void>;
}) {
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
      {openTickets.map(({ ticket, requests }) => {
        const days = businessDaysSince(new Date(ticket.submittedAt));
        return (
          <Card key={ticket.id} className="space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-1">
                <p className="text-sm font-semibold text-foreground">
                  {ticket.description ?? "Epic request"}
                </p>
                <p className="text-xs text-muted-foreground">
                  Submitted {new Date(ticket.submittedAt).toLocaleDateString()} by {ticket.submittedBy.name}
                  <span className={`ml-2 font-medium ${days > 5 ? "text-red-600" : "text-amber-600"}`}>
                    · {days} business day{days !== 1 ? "s" : ""} open
                  </span>
                </p>
                <TicketNumberField
                  ticketId={ticket.id}
                  serviceRequestNumber={ticket.serviceRequestNumber}
                  updateAction={updateServiceRequestNumberAction}
                />
              </div>
              <div className="flex items-center gap-2">
                <Badge tone="warning">Open</Badge>
                <button
                  onClick={() => closeTicketAction(ticket.id)}
                  className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-brand-hover"
                >
                  Mark complete
                </button>
              </div>
            </div>

            <div className="space-y-1">
              {requests.map((r) => (
                <div key={r.id} className="flex items-center gap-2 text-xs text-foreground-soft">
                  <Badge>{r.kind}</Badge>
                  <span>{r.person.name}</span>
                  {r.person.epicId && (
                    <span className="text-subtle-foreground">{r.person.epicId}</span>
                  )}
                </div>
              ))}
            </div>
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
  const closedTickets = history.filter((h) => h.ticket.status === "CLOSED");

  if (closedTickets.length === 0) {
    return <p className="text-sm text-muted-foreground">No completed Epic requests yet.</p>;
  }

  const groups = new Map<string, EpicRequestHistoryRow[]>();
  for (const row of closedTickets) {
    const d = row.ticket.closedAt ?? row.ticket.submittedAt;
    const key = new Date(d).toLocaleDateString("en-US", { month: "long", year: "numeric" });
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }

  return (
    <div className="space-y-8">
      {[...groups.entries()].map(([month, rows]) => (
        <div key={month}>
          <h3 className="text-sm font-semibold text-foreground mb-3">{month}</h3>
          <div className="space-y-4">
            {rows.map(({ ticket, requests }) => (
              <Card key={ticket.id} className="space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-1">
                    <p className="text-sm font-semibold text-foreground">{ticket.description ?? "Epic request"}</p>
                    <p className="text-xs text-muted-foreground">
                      Submitted {new Date(ticket.submittedAt).toLocaleDateString()} by {ticket.submittedBy.name}
                      {ticket.closedAt && <span className="ml-2">· Closed {new Date(ticket.closedAt).toLocaleDateString()}</span>}
                    </p>
                    {ticket.serviceRequestNumber && (
                      <p className="text-xs text-muted-foreground">
                        Service request: <span className="font-medium text-foreground-soft">{ticket.serviceRequestNumber}</span>
                      </p>
                    )}
                  </div>
                  <Badge tone="success">Closed</Badge>
                </div>
                <div className="space-y-1">
                  {requests.map((r) => (
                    <div key={r.id} className="flex items-center gap-2 text-xs text-foreground-soft">
                      <Badge>{r.kind}</Badge>
                      <span>{r.person.name}</span>
                      {r.person.epicId && <span className="text-subtle-foreground">{r.person.epicId}</span>}
                    </div>
                  ))}
                </div>
              </Card>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function EpicRequestTabs({ activeTab, departments, history, pendingDeactivations, closeTicketAction, updateServiceRequestNumberAction }: Props) {
  return (
    <div>
      <Suspense>
        <TabNav activeTab={activeTab} />
      </Suspense>
      {activeTab === "generate" ? (
        <EpicRequestForm departments={departments} pendingDeactivations={pendingDeactivations} />
      ) : activeTab === "tracker" ? (
        <TrackerTable history={history} closeTicketAction={closeTicketAction} updateServiceRequestNumberAction={updateServiceRequestNumberAction} />
      ) : (
        <HistoryTable history={history} />
      )}
    </div>
  );
}