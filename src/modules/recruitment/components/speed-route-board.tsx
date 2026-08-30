"use client";

import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/platform/ui/button";
import { Select } from "@/platform/ui/select";
import { Alert } from "@/platform/ui/alert";
import { Badge } from "@/platform/ui/badge";
import { Card } from "@/platform/ui/card";
import { Checkbox } from "@/platform/ui/checkbox";
import { SectionHeader } from "@/platform/ui/section-header";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { applicationStageLabel, isHandledStage } from "@/modules/recruitment/engine/application-stage";
import { formatScoreSummary } from "@/modules/recruitment/engine/scoring";
import type { SpeedRouteBoard as Board, SpeedRouteRow } from "@/modules/recruitment/services/speed-route";
import type { BatchResult } from "@/modules/recruitment/services/routing";
import { SpeedRouteModal } from "./speed-route-modal";

type Props = {
  board: Board;
  onRoute: (applicationId: string, departmentCode: string) => Promise<{ error?: string }>;
  onReject: (applicationId: string) => Promise<{ error?: string }>;
  onReopen: (applicationId: string) => Promise<{ error?: string }>;
  onApplyTop: (entries: { applicationId: string; departmentCode: string }[]) => Promise<BatchResult | { error: string }>;
  onApplyBottom: (applicationIds: string[]) => Promise<BatchResult | { error: string }>;
};

// Per-row handlers, gathered once so the module-level row/tier components (below)
// stay lint-clean (no component definitions nested inside the board component,
// matching the module-level ApplicationBody pattern in speed-score-modal.tsx).
type RowHandlers = {
  departments: string[];
  deptFor: (r: SpeedRouteRow) => string;
  setDept: (applicationId: string, value: string) => void;
  busy: boolean;
  onRoute: (applicationId: string, departmentCode: string) => void;
  onReject: (applicationId: string) => void;
  onReopen: (applicationId: string) => void;
};

function avgLabel(r: SpeedRouteRow) {
  return formatScoreSummary({ average: r.average, count: r.scoreCount });
}

function RouteRow({ r, kind, h }: { r: SpeedRouteRow; kind: "top" | "middle" | "bottom" | "returned"; h: RowHandlers }) {
  const routable = r.decision === "PENDING" && r.routedDepartmentCode == null;
  const decided = r.decision !== "PENDING";
  return (
    <TR>
      <TD className="font-medium text-foreground">{r.name}</TD>
      <TD className="text-foreground-soft">{avgLabel(r)}</TD>
      <TD className="text-foreground-soft">{r.departmentChoices.join(", ") || "(none)"}</TD>
      <TD><Badge>{applicationStageLabel[r.stage]}</Badge></TD>
      <TD>
        {routable ? (
          <div className="flex flex-wrap items-center gap-2">
            {kind !== "bottom" && (
              <>
                <div className="w-32">
                  <Select
                    value={h.deptFor(r)}
                    onChange={(e) => h.setDept(r.applicationId, e.target.value)}
                    aria-label={`Route ${r.name} to`}
                  >
                    <option value="" disabled>Department…</option>
                    {h.departments
                      // Same exclusion the Returned card makes: a returned applicant
                      // also appears in their score tier, and routing them back to the
                      // department that declined them is refused server-side, so it
                      // must not be offered here either (audit 14, REC-2).
                      .filter((d) => d !== r.returnedFromDepartmentCode)
                      .map((d) => (
                        <option key={d} value={d}>{d}{r.departmentChoices.includes(d) ? " (ranked)" : ""}</option>
                      ))}
                  </Select>
                </div>
                <Button type="button" size="sm" variant="outline" disabled={h.busy || h.deptFor(r) === ""} onClick={() => h.onRoute(r.applicationId, h.deptFor(r))}>Route</Button>
              </>
            )}
            <Button type="button" size="sm" variant="danger" disabled={h.busy} onClick={() => h.onReject(r.applicationId)}>Reject</Button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <span className="text-xs text-subtle-foreground">
              {r.routedDepartmentCode ? `Routed to ${r.routedDepartmentCode}` : ""}
              {decided ? ` ${r.decision.toLowerCase()}` : ""}
            </span>
            {r.decision === "REJECT" && !r.acceptanceEmailed && (
              <Button type="button" size="sm" variant="ghost" disabled={h.busy} onClick={() => h.onReopen(r.applicationId)}>Reopen</Button>
            )}
          </div>
        )}
      </TD>
    </TR>
  );
}

function TierCard({ title, rows, kind, action, h, showHandled }: { title: string; rows: SpeedRouteRow[]; kind: "top" | "middle" | "bottom" | "returned"; action?: ReactNode; h: RowHandlers; showHandled: boolean }) {
  // Display only. The tiers still come from bucketByPercentile over the WHOLE
  // cohort, so hiding finished rows can never move a percentile boundary or
  // change who sits in which tier -- it only shortens the table.
  const shown = showHandled ? rows : rows.filter((r) => !isHandledStage(r.stage));
  const hidden = rows.length - shown.length;
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* "8 of 24", never a bare "8": the tier size is the cohort fact the
            thresholds above are expressed in, so it must not appear to shrink as
            the lead works through the tier. */}
        <SectionHeader>{title} ({hidden > 0 ? `${shown.length} of ${rows.length}` : rows.length})</SectionHeader>
        {action}
      </div>
      {shown.length === 0 ? (
        <p className="mt-3 text-sm text-subtle-foreground">{hidden > 0 ? `All ${rows.length} handled.` : "None."}</p>
      ) : (
        <Table>
          <THead>
            <tr><TH>Name</TH><TH>Committee avg</TH><TH>Ranked</TH><TH>Stage</TH><TH>Action</TH></tr>
          </THead>
          <tbody>{shown.map((r) => <RouteRow key={r.applicationId} r={r} kind={kind} h={h} />)}</tbody>
        </Table>
      )}
    </Card>
  );
}

/**
 * Applicants a department declined and handed back.
 *
 * Kept above the score tiers because this is the only bucket on the board where
 * someone is actively waiting: the applicant has been through scoring and
 * routing already, and a department has said no. Left inside their score tier
 * they would sit among dozens of rows that need no action at all.
 *
 * Rows reuse RouteRow, which already offers the department picker and Reject for
 * them: a returned application is PENDING with no routed department, which is
 * exactly the routable shape.
 */
function ReturnedCard({ rows, h }: { rows: SpeedRouteRow[]; h: RowHandlers }) {
  if (rows.length === 0) return null;
  return (
    <Card>
      <SectionHeader>Returned for re-routing ({rows.length})</SectionHeader>
      <p className="mt-2 text-sm text-subtle-foreground">
        A department declined these applicants as not a fit for them. Route each one somewhere else, or reject the application.
      </p>
      <Table>
        <THead>
          <tr><TH>Name</TH><TH>Committee avg</TH><TH>Returned by</TH><TH>Reason</TH><TH>Action</TH></tr>
        </THead>
        <tbody>
          {rows.map((r) => (
            <TR key={r.applicationId}>
              <TD className="font-medium text-foreground">{r.name}</TD>
              <TD className="text-foreground-soft">{avgLabel(r)}</TD>
              <TD className="text-foreground-soft">{r.returnedFromDepartmentCode ?? "-"}</TD>
              <TD className="text-foreground-soft">{r.returnedReason || "(none given)"}</TD>
              <TD>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="w-32">
                    <Select
                      value={h.deptFor(r)}
                      onChange={(e) => h.setDept(r.applicationId, e.target.value)}
                      aria-label={`Re-route ${r.name} to`}
                    >
                      <option value="" disabled>Department…</option>
                      {h.departments
                        // The department that just declined them is not offered:
                        // routing straight back is never the intended action and
                        // would land the applicant in the same queue they left.
                        .filter((d) => d !== r.returnedFromDepartmentCode)
                        .map((d) => (
                          <option key={d} value={d}>{d}{r.departmentChoices.includes(d) ? " (ranked)" : ""}</option>
                        ))}
                    </Select>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={h.busy || h.deptFor(r) === "" || h.deptFor(r) === r.returnedFromDepartmentCode}
                    onClick={() => h.onRoute(r.applicationId, h.deptFor(r))}
                  >
                    Route
                  </Button>
                  <Button type="button" size="sm" variant="danger" disabled={h.busy} onClick={() => h.onReject(r.applicationId)}>Reject</Button>
                </div>
              </TD>
            </TR>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

export function SpeedRouteBoard({ board, onRoute, onReject, onReopen, onApplyTop, onApplyBottom }: Props) {
  const router = useRouter();
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | "top" | "bottom">(null);
  // Rows the lead has finished with (routed, interviewing, decided) are hidden
  // from the tier tables by default: their action cell is already inert, so on a
  // worked-through board they were dozens of rows of nothing-to-do standing
  // between the handful that still need a decision. Off by default matches the
  // "Route the middle" modal, which has always hidden them the same way.
  const [showHandled, setShowHandled] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [busy, startBusy] = useTransition();

  const deptFor = (r: SpeedRouteRow) => overrides[r.applicationId] ?? r.proposedDepartmentCode ?? "";
  const refresh = () => router.refresh();

  /**
   * Rows a bulk tier action may touch.
   *
   * Excludes returned applicants even though they LOOK eligible (PENDING with no
   * routed department, the same shape as a never-routed row). Two ways that goes
   * wrong otherwise: "Apply top tier" routes on proposedDepartmentCode, which is
   * their FIRST CHOICE, and that is frequently the department that just declined
   * them, so the bulk action would hand them straight back; and "Apply bottom
   * tier" would silently reject someone a department deliberately returned for
   * re-routing rather than rejecting. Either way a human judgment already exists
   * on these rows, so they belong to the Returned card's per-row controls.
   */
  const batchEligible = (r: SpeedRouteRow) =>
    r.decision === "PENDING" && r.routedDepartmentCode == null && r.returnedFromDepartmentCode == null;

  function runSingle(fn: () => Promise<{ error?: string }>) {
    setError(null);
    setNote(null);
    startBusy(async () => {
      const res = await fn();
      if (res?.error) { setError(res.error); return; }
      refresh();
    });
  }

  const h: RowHandlers = {
    departments: board.departments,
    deptFor,
    setDept: (id, value) => setOverrides((p) => ({ ...p, [id]: value })),
    busy,
    onRoute: (id, dept) => runSingle(() => onRoute(id, dept)),
    onReject: (id) => runSingle(() => onReject(id)),
    onReopen: (id) => runSingle(() => onReopen(id)),
  };

  function applyTop() {
    setConfirm(null);
    setError(null);
    setNote(null);
    const entries = board.top
      .filter(batchEligible)
      .map((r) => ({ applicationId: r.applicationId, departmentCode: deptFor(r) }))
      .filter((e) => e.departmentCode !== "");
    if (entries.length === 0) { setError("No top-tier rows have a department to route to."); return; }
    startBusy(async () => {
      const res = await onApplyTop(entries);
      if ("error" in res) { setError(res.error); return; }
      setNote(`Routed ${res.applied}${res.skipped.length ? `, skipped ${res.skipped.length}` : ""}.`);
      refresh();
    });
  }

  function applyBottom() {
    setConfirm(null);
    setError(null);
    setNote(null);
    // Match `routable`/`applyTop`: never auto-reject an applicant a lead already
    // manually routed to a department, even if their committee average lands them
    // in the bottom bucket.
    const ids = board.bottom.filter(batchEligible).map((r) => r.applicationId);
    if (ids.length === 0) { setError("No bottom-tier rows to reject."); return; }
    startBusy(async () => {
      const res = await onApplyBottom(ids);
      if ("error" in res) { setError(res.error); return; }
      setNote(`Rejected ${res.applied}${res.skipped.length ? `, skipped ${res.skipped.length}` : ""}.`);
      refresh();
    });
  }

  // The button/confirm count must match what applyTop actually routes: it drops any
  // row with no department (proposedDepartmentCode null -- e.g. the first choice was a
  // department later removed from the cycle -- and no manual override). Counting the
  // unfiltered set made "Apply top tier (12)" route only the 9 with a department and
  // silently leave 3 unrouted with no explanation (#98).
  const topPending = board.top.filter(batchEligible);
  const topRoutable = topPending.filter((r) => deptFor(r) !== "").length;
  const topMissingDept = topPending.length - topRoutable;
  const bottomPending = board.bottom.filter(batchEligible).length;

  const handledInTiers = [...board.top, ...board.middle, ...board.bottom].filter((r) =>
    isHandledStage(r.stage),
  ).length;
  // Renewals, and applicants whose first choice auto-routes, are routed AT
  // SUBMISSION and never scored (submissions.ts), so they arrive here with a null
  // average. "Score these before they can be routed" is simply false for them --
  // they have been with a department the whole time -- and on a renewal-heavy
  // cycle they were the bulk of the list.
  const unscoredPending = board.unscored.filter((r) => !isHandledStage(r.stage));
  const unscoredHandled = board.unscored.length - unscoredPending.length;

  return (
    <div className="space-y-5">
      {error && <Alert tone="error">{error}</Alert>}
      {note && <Alert tone="success">{note}</Alert>}

      {handledInTiers > 0 && (
        <div className="flex justify-end">
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Checkbox checked={showHandled} onChange={(e) => setShowHandled(e.target.checked)} />
            Show handled ({handledInTiers})
          </label>
        </div>
      )}

      <ReturnedCard rows={board.returned} h={h} />

      <TierCard
        title="Top"
        rows={board.top}
        kind="top"
        h={h}
        showHandled={showHandled}
        action={
          topRoutable > 0 ? (
            confirm === "top" ? (
              <div className="flex items-center gap-2 text-sm">
                <span>
                  Route {topRoutable} to their selected department?
                  {topMissingDept > 0 && <span className="text-subtle-foreground"> ({topMissingDept} still need a department)</span>}
                </span>
                <Button type="button" size="sm" variant="primary" disabled={busy} onClick={applyTop}>Confirm</Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <Button type="button" size="sm" variant="primary" disabled={busy} onClick={() => setConfirm("top")}>Apply top tier ({topRoutable})</Button>
                {topMissingDept > 0 && <span className="text-xs text-subtle-foreground">{topMissingDept} need a department first</span>}
              </div>
            )
          ) : topMissingDept > 0 ? (
            <span className="text-xs text-subtle-foreground">{topMissingDept} top-tier applicant{topMissingDept === 1 ? "" : "s"} need a department before routing</span>
          ) : null
        }
      />

      <TierCard
        title="Middle"
        rows={board.middle}
        kind="middle"
        h={h}
        showHandled={showHandled}
        action={
          board.middle.length > 0 ? (
            <Button type="button" size="sm" variant="outline" onClick={() => setModalOpen(true)}>Route the middle</Button>
          ) : null
        }
      />

      <TierCard
        title="Bottom"
        rows={board.bottom}
        kind="bottom"
        h={h}
        showHandled={showHandled}
        action={
          bottomPending > 0 ? (
            confirm === "bottom" ? (
              <div className="flex items-center gap-2 text-sm">
                <span>Reject {bottomPending} applicants?</span>
                <Button type="button" size="sm" variant="danger" disabled={busy} onClick={applyBottom}>Confirm</Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button>
              </div>
            ) : (
              <Button type="button" size="sm" variant="danger" disabled={busy} onClick={() => setConfirm("bottom")}>Apply bottom tier ({bottomPending})</Button>
            )
          ) : null
        }
      />

      {unscoredPending.length > 0 && (
        <Card>
          <SectionHeader>Unscored ({unscoredPending.length})</SectionHeader>
          <p className="mt-2 text-sm text-subtle-foreground">Score these before they can be routed: {unscoredPending.map((r) => r.name).join(", ")}.</p>
          {unscoredHandled > 0 && (
            <p className="mt-2 text-sm text-subtle-foreground">
              {unscoredHandled} more {unscoredHandled === 1 ? "applicant" : "applicants"} skipped committee scoring and went straight to a department. Nothing to do for them here.
            </p>
          )}
        </Card>
      )}

      {modalOpen && (
        <SpeedRouteModal
          open={modalOpen}
          onClose={() => { setModalOpen(false); refresh(); }}
          rows={board.middle}
          departments={board.departments}
          onRoute={onRoute}
          onReject={onReject}
        />
      )}
    </div>
  );
}
