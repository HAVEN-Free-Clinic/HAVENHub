"use client";

import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/platform/ui/button";
import { Select } from "@/platform/ui/select";
import { Alert } from "@/platform/ui/alert";
import { Badge } from "@/platform/ui/badge";
import { Card } from "@/platform/ui/card";
import { SectionHeader } from "@/platform/ui/section-header";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { applicationStageLabel } from "@/modules/recruitment/engine/application-stage";
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

function RouteRow({ r, kind, h }: { r: SpeedRouteRow; kind: "top" | "middle" | "bottom"; h: RowHandlers }) {
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
                    {h.departments.map((d) => (
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

function TierCard({ title, rows, kind, action, h }: { title: string; rows: SpeedRouteRow[]; kind: "top" | "middle" | "bottom"; action?: ReactNode; h: RowHandlers }) {
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionHeader>{title} ({rows.length})</SectionHeader>
        {action}
      </div>
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-subtle-foreground">None.</p>
      ) : (
        <Table>
          <THead>
            <tr><TH>Name</TH><TH>Committee avg</TH><TH>Ranked</TH><TH>Stage</TH><TH>Action</TH></tr>
          </THead>
          <tbody>{rows.map((r) => <RouteRow key={r.applicationId} r={r} kind={kind} h={h} />)}</tbody>
        </Table>
      )}
    </Card>
  );
}

export function SpeedRouteBoard({ board, onRoute, onReject, onReopen, onApplyTop, onApplyBottom }: Props) {
  const router = useRouter();
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | "top" | "bottom">(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [busy, startBusy] = useTransition();

  const deptFor = (r: SpeedRouteRow) => overrides[r.applicationId] ?? r.proposedDepartmentCode ?? "";
  const refresh = () => router.refresh();

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
      .filter((r) => r.decision === "PENDING" && r.routedDepartmentCode == null)
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
    const ids = board.bottom
      .filter((r) => r.decision === "PENDING" && r.routedDepartmentCode == null)
      .map((r) => r.applicationId);
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
  const topPending = board.top.filter((r) => r.decision === "PENDING" && r.routedDepartmentCode == null);
  const topRoutable = topPending.filter((r) => deptFor(r) !== "").length;
  const topMissingDept = topPending.length - topRoutable;
  const bottomPending = board.bottom.filter((r) => r.decision === "PENDING" && r.routedDepartmentCode == null).length;

  return (
    <div className="space-y-5">
      {error && <Alert tone="error">{error}</Alert>}
      {note && <Alert tone="success">{note}</Alert>}

      <TierCard
        title="Top"
        rows={board.top}
        kind="top"
        h={h}
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

      {board.unscored.length > 0 && (
        <Card>
          <SectionHeader>Unscored ({board.unscored.length})</SectionHeader>
          <p className="mt-2 text-sm text-subtle-foreground">Score these before they can be routed: {board.unscored.map((r) => r.name).join(", ")}.</p>
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
