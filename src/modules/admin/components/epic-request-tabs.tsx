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
import type { DepartmentWithMembers, EpicRequestHistoryRow } from "@/modules/admin/services/itcm";

type Tab = "generate" | "tracker";

type Props = {
  activeTab: Tab;
  departments: DepartmentWithMembers[];
  history: EpicRequestHistoryRow[];
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

  const labels: Record<Tab, string> = { generate: "Generate", tracker: "Tracker" };

  return (
    <div className="flex gap-4 border-b border-slate-200 mb-8">
      {(["generate", "tracker"] as Tab[]).map((tab) => (
        <button
          key={tab}
          onClick={() => goTo(tab)}
          className={`pb-3 text-sm font-semibold border-b-2 transition-colors ${
            activeTab === tab
              ? "border-brand text-brand"
              : "border-transparent text-slate-500 hover:text-slate-600"
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

function TrackerTable({ history }: { history: EpicRequestHistoryRow[] }) {
  if (history.length === 0) {
    return (
      <p className="text-sm text-slate-500">
        No Epic requests submitted yet. Generate a PDF to get started.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {history.map(({ ticket, requests }) => {
        const days = ticket.status === "OPEN" ? businessDaysSince(new Date(ticket.submittedAt)) : null;
        return (
          <Card key={ticket.id} className="space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-1">
                <p className="text-sm font-semibold text-slate-800">
                  {ticket.description ?? "Epic request"}
                </p>
                <p className="text-xs text-slate-500">
                  Submitted {new Date(ticket.submittedAt).toLocaleDateString()} by {ticket.submittedBy.name}
                  {days !== null && (
                    <span className={`ml-2 font-medium ${days > 5 ? "text-red-600" : "text-amber-600"}`}>
                      · {days} business day{days !== 1 ? "s" : ""} open
                    </span>
                  )}
                </p>
                {ticket.serviceRequestNumber && (
                  <p className="text-xs text-slate-500">
                    Service request: <span className="font-medium text-slate-700">{ticket.serviceRequestNumber}</span>
                  </p>
                )}
              </div>
              {ticket.status === "OPEN" ? (
                <Badge tone="warning">Open</Badge>
              ) : (
                <Badge tone="success">Closed</Badge>
              )}
            </div>

            <div className="space-y-1">
              {requests.map((r) => (
                <div key={r.id} className="flex items-center gap-2 text-xs text-slate-600">
                  <Badge>{r.kind}</Badge>
                  <span>{r.person.name}</span>
                  {r.person.epicId && (
                    <span className="text-slate-400">{r.person.epicId}</span>
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
// Main export
// ---------------------------------------------------------------------------

export function EpicRequestTabs({ activeTab, departments, history }: Props) {
  return (
    <div>
      <Suspense>
        <TabNav activeTab={activeTab} />
      </Suspense>
      {activeTab === "generate" ? (
        <EpicRequestForm departments={departments} />
      ) : (
        <TrackerTable history={history} />
      )}
    </div>
  );
}