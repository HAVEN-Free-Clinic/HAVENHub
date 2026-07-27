"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { Modal } from "@/platform/ui/modal";
import { Button } from "@/platform/ui/button";
import { Badge } from "@/platform/ui/badge";
import { Alert } from "@/platform/ui/alert";
import { Spinner } from "@/platform/ui/spinner";
import { Checkbox } from "@/platform/ui/checkbox";
import type { SpeedRouteRow } from "@/modules/recruitment/services/speed-route";
import { formatScoreSummary } from "@/modules/recruitment/engine/scoring";

type SpeedRouteModalProps = {
  open: boolean;
  onClose: () => void;
  rows: SpeedRouteRow[];
  departments: string[];
  onRoute: (applicationId: string, departmentCode: string) => Promise<{ error?: string }>;
  onReject: (applicationId: string) => Promise<{ error?: string }>;
};

export function SpeedRouteModal({ open, onClose, rows, departments, onRoute, onReject }: SpeedRouteModalProps) {
  // Freeze the row set at open so live routing never reindexes the queue.
  const [snapshot] = useState(() => rows);
  const [includeDecided, setIncludeDecided] = useState(false);
  const [index, setIndex] = useState(0);
  // Ids acted on (routed or rejected). Seeded from rows ALREADY handled before the
  // modal opened so handledCount and total ("You handled X of Y") are measured over
  // the same population -- previously acted started empty while total counted the
  // whole snapshot, so clearing the remaining N of M read "handled N of M" and kept
  // the "Review handled" button visible as if some were outstanding (#99). Mirrors
  // speed-score-modal, which seeds its counter from pre-existing per-row state.
  const [acted, setActed] = useState<Record<string, true>>(() =>
    Object.fromEntries(
      snapshot
        .filter((r) => r.decision !== "PENDING" || r.routedDepartmentCode != null)
        .map((r) => [r.applicationId, true] as const),
    ),
  );
  const [error, setError] = useState<string | null>(null);
  const [isSaving, startSave] = useTransition();
  // Applicant to keep in view across a show-decided toggle.
  const keepIdRef = useRef<string | null>(null);

  // Queue basis is the FROZEN snapshot, never `acted`: like speed-score, a row that
  // was undecided at open stays in the queue after you handle it (snapshot.decision
  // is frozen), so the queue identity is stable and you advance past it by index.
  // Depending on `acted` here would recompute the queue on every action and make the
  // reposition effect below reset the index to 0 instead of advancing.
  const queue = useMemo(
    () => (includeDecided ? snapshot : snapshot.filter((r) => r.decision === "PENDING" && r.routedDepartmentCode == null)),
    [snapshot, includeDecided],
  );

  // Reset position when the queue basis changes; preserve the toggled-from applicant.
  useEffect(() => {
    const keepId = keepIdRef.current;
    keepIdRef.current = null;
    const pos = keepId ? queue.findIndex((q) => q.applicationId === keepId) : -1;
    setIndex(pos >= 0 ? pos : 0);
  }, [queue]);

  const total = snapshot.length;
  const handledCount = Object.keys(acted).length;
  const current = index < queue.length ? queue[index] : null;
  const done = current == null;

  const goTo = useCallback((next: number) => setIndex(() => Math.min(Math.max(0, next), queue.length)), [queue.length]);

  const routeTo = useCallback(
    (departmentCode: string) => {
      if (!current || isSaving) return;
      const id = current.applicationId;
      setError(null);
      startSave(async () => {
        const res = await onRoute(id, departmentCode);
        if (res?.error) { setError(res.error); return; }
        setActed((p) => ({ ...p, [id]: true }));
        setIndex((i) => i + 1);
      });
    },
    [current, isSaving, onRoute],
  );

  const rejectCurrent = useCallback(() => {
    if (!current || isSaving) return;
    const id = current.applicationId;
    setError(null);
    startSave(async () => {
      const res = await onReject(id);
      if (res?.error) { setError(res.error); return; }
      setActed((p) => ({ ...p, [id]: true }));
      setIndex((i) => i + 1);
    });
  }, [current, isSaving, onReject]);

  // Ranked departments that are real cycle departments, in the applicant's order.
  const rankedDepts = useMemo(() => {
    if (!current) return [];
    const set = new Set(departments);
    return current.departmentChoices.filter((d) => set.has(d)).slice(0, 9);
  }, [current, departments]);

  // Keyboard: number keys route to the k-th ranked dept; R rejects; arrows navigate.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (done || isSaving) return;
      if (e.key >= "1" && e.key <= "9") {
        const i = Number(e.key) - 1;
        if (i < rankedDepts.length) { e.preventDefault(); routeTo(rankedDepts[i]); }
      } else if (e.key === "r" || e.key === "R") {
        e.preventDefault();
        rejectCurrent();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        goTo(index + 1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        goTo(index - 1);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, done, isSaving, index, rankedDepts, routeTo, rejectCurrent, goTo]);

  function toggleShowDecided(next: boolean) {
    keepIdRef.current = current?.applicationId ?? null;
    setIncludeDecided(next);
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="large"
      title={done ? "Route the middle" : `${current!.name}  (${index + 1} of ${queue.length})`}
      footer={
        done ? (
          <Button type="button" variant="primary" size="sm" onClick={onClose}>Close</Button>
        ) : (
          <div className="flex w-full flex-wrap items-center gap-1.5">
            {rankedDepts.map((d, i) => (
              <Button key={d} type="button" size="sm" variant="outline" disabled={isSaving} onClick={() => routeTo(d)}>
                {i + 1}. {d}
              </Button>
            ))}
            <Button type="button" size="sm" variant="danger" disabled={isSaving} onClick={rejectCurrent}>Reject (R)</Button>
            {isSaving && <Spinner size="sm" className="ml-1 text-muted-foreground" />}
          </div>
        )
      }
    >
      {done ? (
        <div className="space-y-3 py-6 text-center">
          <p className="text-lg font-semibold text-foreground">Middle tier cleared.</p>
          <p className="text-sm text-muted-foreground">You handled {handledCount} of {total} applicants.</p>
          {!includeDecided && handledCount < total && (
            <Button type="button" variant="outline" size="sm" onClick={() => toggleShowDecided(true)}>Review handled applicants</Button>
          )}
        </div>
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge>{formatScoreSummary({ average: current!.average, count: current!.scoreCount })}</Badge>
            <span className="text-muted-foreground">Ranked: {current!.departmentChoices.join(", ") || "(none)"}</span>
            <label className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
              <Checkbox checked={includeDecided} onChange={(e) => toggleShowDecided(e.target.checked)} />
              Show handled
            </label>
          </div>
          {error && <Alert tone="error">{error}</Alert>}
          {rankedDepts.length === 0 && (
            <Alert tone="warning">This applicant ranked no cycle department. Reject, skip, or route from the board.</Alert>
          )}
          <p className="text-xs text-subtle-foreground">
            Press 1-{Math.max(rankedDepts.length, 1)} to route to a ranked department, R to reject, Left/Right to move, Esc to close.
          </p>
        </div>
      )}
    </Modal>
  );
}
