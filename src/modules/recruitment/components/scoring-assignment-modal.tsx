"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { Modal } from "@/platform/ui/modal";
import { Button } from "@/platform/ui/button";
import { Alert } from "@/platform/ui/alert";
import { Badge } from "@/platform/ui/badge";
import { Spinner } from "@/platform/ui/spinner";
import { Checkbox } from "@/platform/ui/checkbox";
import { Input } from "@/platform/ui/input";
import { EmptyState } from "@/platform/ui/empty-state";
import { runAction } from "@/platform/ui/run-action";
import type { ScoringPanel } from "@/modules/recruitment/services/score-assignment";

export type ScoringAssignmentModalProps = {
  open: boolean;
  onClose: () => void;
  cycleId: string;
  onLoad: (cycleId: string) => Promise<{ panel: ScoringPanel } | { error: string }>;
  onSave: (
    cycleId: string,
    input: { scorerIds: string[]; target: number },
  ) => Promise<{ added: number; removed: number; error?: string }>;
};

/**
 * Pick who is scoring this cycle and how many people should read each
 * application, then divide the roster to match.
 *
 * The panel loads on open rather than with the page: it is a lead-only tool
 * opened rarely, and the counts it shows go stale the moment anyone scores
 * anything, so reading them fresh is both cheaper and more honest.
 */
export function ScoringAssignmentModal({ open, onClose, cycleId, onLoad, onSave }: ScoringAssignmentModalProps) {
  const [panel, setPanel] = useState<ScoringPanel | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState("2");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ added: number; removed: number } | null>(null);
  const [isSaving, startSave] = useTransition();

  useEffect(() => {
    if (!open) return;
    let live = true;
    // No state reset here: the launcher renders this only while open, so every
    // open is a fresh mount and the initial state already is the reset. That
    // also keeps setState out of an effect body.
    void (async () => {
      // Bare try/catch rather than runAction: this returns a discriminated
      // union, not the { error?: string } shape runAction is typed for. Same
      // reasoning as speed-score-modal's ensureLoaded, and the catch matters
      // for the same reason: without it a rejection leaves the spinner up
      // forever with no banner.
      try {
        const res = await onLoad(cycleId);
        if (!live) return;
        if ("error" in res) {
          setError(res.error);
          return;
        }
        setPanel(res.panel);
        setSelected(new Set(res.panel.candidates.filter((c) => c.inPool).map((c) => c.personId)));
        setTarget(String(res.panel.target));
      } catch {
        if (live) setError("Could not load the scorer list. Try again.");
      }
    })();
    return () => { live = false; };
  }, [open, cycleId, onLoad]);

  const targetNumber = Number(target);
  const targetValid = Number.isInteger(targetNumber) && targetNumber >= 1 && targetNumber <= 20;
  // The pool is what limits real coverage, not the number in the box. Saying so
  // here beats letting the lead save a target of five to a pool of three and
  // then wonder why every row reads "3 of 5".
  const shortPool = targetValid && selected.size > 0 && selected.size < targetNumber;
  const perScorer = useMemo(() => {
    if (!panel || selected.size === 0 || !targetValid) return null;
    return Math.ceil((panel.eligibleCount * Math.min(targetNumber, selected.size)) / selected.size);
  }, [panel, selected.size, targetNumber, targetValid]);

  function toggle(personId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(personId)) next.delete(personId);
      else next.add(personId);
      return next;
    });
    setSaved(null);
  }

  function save() {
    if (!targetValid) return;
    setError(null);
    setSaved(null);
    startSave(async () => {
      const res = await runAction(() => onSave(cycleId, { scorerIds: [...selected], target: targetNumber }));
      if (res.error) {
        setError(res.error);
        return;
      }
      // runAction widens the result with its own bare { error } for a rejection,
      // and a falsy `error` does not narrow that away (an empty string is a
      // valid string), so pick the counts off the shape that carries them.
      setSaved("added" in res ? { added: res.added, removed: res.removed } : { added: 0, removed: 0 });
      // Re-read so the per-scorer counts reflect the division just made. A
      // failure here is not worth a banner: the save landed, and the counts
      // catch up when the panel is next opened.
      try {
        const reloaded = await onLoad(cycleId);
        if (!("error" in reloaded)) setPanel(reloaded.panel);
      } catch { /* counts stay stale; the save itself succeeded */ }
    });
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Assign scoring"
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onClose}>Close</Button>
          <Button type="button" variant="primary" size="sm" onClick={save} disabled={isSaving || !panel || !targetValid}>
            {isSaving ? "Assigning…" : "Save and assign"}
          </Button>
        </div>
      }
    >
      {error && <Alert tone="error" className="mb-3">{error}</Alert>}
      {saved && (
        <Alert tone="success" className="mb-3">
          {saved.added === 0 && saved.removed === 0
            ? "Everything was already covered. Nothing changed."
            : `Handed out ${saved.added}, took back ${saved.removed}.`}
        </Alert>
      )}
      {!panel ? (
        <div className="flex items-center gap-2 py-6 text-sm text-subtle-foreground">
          <Spinner /> Loading scorers…
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-foreground-soft">
            {panel.eligibleCount === 1
              ? "1 application is still waiting on the committee."
              : `${panel.eligibleCount} applications are still waiting on the committee.`}
            {panel.underTargetCount > 0 && ` ${panel.underTargetCount} of them are short of the target.`}
          </p>

          <div className="max-w-xs">
            <label htmlFor="scores-per-application" className="text-xs text-subtle-foreground">
              Scores per application
            </label>
            <Input
              id="scores-per-application"
              type="number"
              min={1}
              max={20}
              value={target}
              onChange={(e) => { setTarget(e.target.value); setSaved(null); }}
              className="mt-1"
            />
            {!targetValid && (
              <p className="mt-1 text-xs text-critical">Enter a whole number from 1 to 20.</p>
            )}
            {shortPool && (
              <p className="mt-1 text-xs text-subtle-foreground">
                Only {selected.size} {selected.size === 1 ? "person is" : "people are"} scoring, so each application
                can get at most {selected.size}.
              </p>
            )}
            {perScorer != null && (
              <p className="mt-1 text-xs text-subtle-foreground">
                About {perScorer} {perScorer === 1 ? "application" : "applications"} each.
              </p>
            )}
          </div>

          <div>
            <p className="text-xs text-subtle-foreground">
              Who is scoring this cycle. Everyone listed already holds the committee scoring permission.
            </p>
            {panel.candidates.length === 0 ? (
              <EmptyState inline className="mt-2">
                Nobody holds the committee scoring permission yet. Grant it from Admin first.
              </EmptyState>
            ) : (
              <ul className="mt-2 divide-y divide-border rounded-md border border-border">
                {panel.candidates.map((c) => (
                  <li key={c.personId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                    <Checkbox
                      label={c.name}
                      checked={selected.has(c.personId)}
                      onChange={() => toggle(c.personId)}
                    />
                    <span className="flex items-center gap-1.5">
                      {c.assigned > 0 && (
                        <Badge tone={c.scored >= c.assigned ? "success" : undefined}>
                          {c.scored} of {c.assigned} done
                        </Badge>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <p className="text-xs text-subtle-foreground">
            Unchecking someone hands their unfinished applications to the rest of the pool. Scores they already
            submitted stay. Clearing the list entirely turns this off, and everyone sees the whole roster again.
          </p>
        </div>
      )}
    </Modal>
  );
}
