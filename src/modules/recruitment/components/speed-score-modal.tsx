"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { Modal } from "@/platform/ui/modal";
import { Button } from "@/platform/ui/button";
import { Badge } from "@/platform/ui/badge";
import { Alert } from "@/platform/ui/alert";
import { Spinner } from "@/platform/ui/spinner";
import { Input } from "@/platform/ui/input";
import { Checkbox } from "@/platform/ui/checkbox";
import { buildSpeedScoreQueue, type SpeedScoreItem } from "@/modules/recruitment/engine/speed-score-queue";
import type { ReviewApplicationView } from "@/modules/recruitment/services/speed-score";
import { DocumentPreview } from "./document-preview";

type SpeedScoreModalProps = {
  open: boolean;
  onClose: () => void;
  items: SpeedScoreItem[];
  onScore: (applicationId: string, score: number, comments: string | null) => Promise<{ error?: string }>;
  onLoad: (applicationId: string) => Promise<{ view: ReviewApplicationView } | { error: string }>;
};

export function SpeedScoreModal({ open, onClose, items, onScore, onLoad }: SpeedScoreModalProps) {
  // Opening snapshot: freeze the item set so live scoring never reindexes the queue.
  const snapshot = useRef<SpeedScoreItem[]>(items);
  const [includeScored, setIncludeScored] = useState(false);
  const [index, setIndex] = useState(0);
  const [liveScores, setLiveScores] = useState<Record<string, number | null>>(() =>
    Object.fromEntries(items.map((i) => [i.applicationId, i.myScore])),
  );
  const [views, setViews] = useState<Record<string, ReviewApplicationView>>({});
  const [viewError, setViewError] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, startSave] = useTransition();

  const { queue, initialIndex } = useMemo(
    // eslint-disable-next-line react-hooks/refs -- snapshot.current is set once at mount and never reassigned; reading the frozen queue basis is safe
    () => buildSpeedScoreQueue(snapshot.current, { includeScored }),
    [includeScored],
  );

  // Reset position when the queue basis changes (open, or toggle).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- derived-state reset when the queue basis (initialIndex) changes; intentional per component contract
    setIndex(initialIndex);
  }, [initialIndex]);

  const total = snapshot.current.length;
  const scoredCount = Object.values(liveScores).filter((v) => v != null).length;
  const current = index < queue.length ? queue[index] : null;
  const done = current == null;
  const currentView = current ? views[current.applicationId] : undefined;

  const ensureLoaded = useCallback(
    // eslint-disable-next-line react-hooks/preserve-manual-memoization -- deps intentionally match the brief's contract
    async (applicationId: string, isCurrent: boolean) => {
      // Read latest views via functional update to avoid a stale closure.
      let alreadyHave = false;
      setViews((prev) => {
        alreadyHave = Boolean(prev[applicationId]);
        return prev;
      });
      if (alreadyHave) return;
      const res = await onLoad(applicationId);
      if ("view" in res) {
        setViews((prev) => ({ ...prev, [applicationId]: res.view }));
      } else if (isCurrent) {
        setViewError(res.error);
      }
    },
    [onLoad],
  );

  // Load current + prefetch next whenever the position changes.
  useEffect(() => {
    if (!open || !current) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clears stale error/comment when position changes, before the async prefetch below
    setViewError(null);
    setComment("");
    void ensureLoaded(current.applicationId, true);
    const next = queue[index + 1];
    if (next) void ensureLoaded(next.applicationId, false);
  }, [open, current, queue, index, ensureLoaded]);

  const goTo = useCallback(
    // eslint-disable-next-line react-hooks/preserve-manual-memoization -- deps intentionally match the brief's contract
    (nextIndex: number) => {
      setIndex((_i) => Math.min(Math.max(0, nextIndex), queue.length));
    },
    [queue.length],
  );

  const handleScore = useCallback(
    // eslint-disable-next-line react-hooks/preserve-manual-memoization -- deps intentionally match the brief's contract
    (value: number) => {
      if (!current || isSaving) return;
      const target = current.applicationId;
      const note = comment.trim() ? comment.trim() : null;
      setSaveError(null);
      startSave(async () => {
        const res = await onScore(target, value, note);
        if (res?.error) {
          setSaveError(res.error);
          return;
        }
        setLiveScores((prev) => ({ ...prev, [target]: value }));
        setIndex((i) => i + 1);
      });
    },
    [current, isSaving, comment, onScore],
  );

  // Global keyboard: 1-5 scores + advances; arrows navigate. Suppressed while a
  // form control is focused (comment field), while saving, and on the done screen.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (done || isSaving) return;
      if (e.key >= "1" && e.key <= "5") {
        e.preventDefault();
        handleScore(Number(e.key));
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
  }, [open, done, isSaving, index, handleScore, goTo]);

  const currentScore = current ? liveScores[current.applicationId] ?? null : null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="large"
      title={
        done
          ? "Speed score"
          : current
            ? `${current.name}  (${index + 1} of ${queue.length})`
            : "Speed score"
      }
      footer={
        done ? (
          <Button type="button" variant="primary" size="sm" onClick={onClose}>Close</Button>
        ) : (
          <div className="flex w-full flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-1.5">
              {[1, 2, 3, 4, 5].map((n) => (
                <Button
                  key={n}
                  type="button"
                  size="sm"
                  variant={currentScore === n ? "primary" : "outline"}
                  disabled={isSaving}
                  onClick={() => handleScore(n)}
                  aria-label={`Score ${n}`}
                >
                  {n}
                </Button>
              ))}
              {isSaving && <Spinner size="sm" className="ml-1 text-muted-foreground" />}
            </div>
            <div className="w-64 max-w-full">
              <Input
                placeholder="Comment (optional)"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                aria-label="Comment (optional)"
              />
            </div>
          </div>
        )
      }
    >
      {done ? (
        <div className="space-y-3 py-6 text-center">
          <p className="text-lg font-semibold text-foreground">All caught up.</p>
          {/* eslint-disable-next-line react-hooks/refs -- total derives from the frozen opening snapshot (never reassigned); safe to read during render */}
          <p className="text-sm text-muted-foreground">You&apos;ve scored {scoredCount} of {total} applicants.</p>
          {/* eslint-disable-next-line react-hooks/refs -- total derives from the frozen opening snapshot (never reassigned); safe to read during render */}
          {!includeScored && scoredCount < total && (
            <Button type="button" variant="outline" size="sm" onClick={() => setIncludeScored(true)}>
              Review scored applicants
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge>{current!.typeLabel}</Badge>
            <span className="text-muted-foreground">{currentView?.email}</span>
            {currentView && currentView.departmentChoices.length > 0 && (
              <span className="text-muted-foreground">Prefs: {currentView.departmentChoices.join(", ")}</span>
            )}
            <label className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
              <Checkbox checked={includeScored} onChange={(e) => setIncludeScored(e.target.checked)} />
              Show scored
            </label>
          </div>

          {saveError && <Alert tone="error">{saveError}</Alert>}
          {viewError && <Alert tone="error">{viewError}</Alert>}

          {!currentView && !viewError && (
            <div className="flex items-center justify-center py-16"><Spinner size="lg" /></div>
          )}

          {currentView && <ApplicationBody view={currentView} />}

          <p className="text-xs text-subtle-foreground">
            Press 1-5 to score and advance. Left/Right to move. Esc to close.
          </p>
        </div>
      )}
    </Modal>
  );
}

/** Renders the condensed application: scalars in a dense grid, essays full-width,
 *  files as expand-on-demand previews. Fields are flattened across sections and
 *  bucketed by `kind` (matches the approved mockup). */
function ApplicationBody({ view }: { view: ReviewApplicationView }) {
  const all = view.sections.flatMap((s) => s.fields.map((f) => ({ ...f, section: s.title })));
  const scalars = all.filter((f) => f.kind === "scalar");
  const essays = all.filter((f) => f.kind === "essay");
  const files = all.filter((f) => f.kind === "file" && f.file);

  return (
    <div className="space-y-5">
      {scalars.length > 0 && (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-subtle-foreground">At a glance</h3>
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            {scalars.map((f) => (
              <div key={f.key}>
                <dt className="text-xs text-subtle-foreground">{f.label}</dt>
                <dd className="mt-0.5 text-sm text-foreground">{f.displayValue}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      {essays.length > 0 && (
        <section className="space-y-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-subtle-foreground">Essays</h3>
          {essays.map((f) => (
            <div key={f.key}>
              <h4 className="text-sm font-medium text-foreground">{f.label}</h4>
              <p className="mt-1 whitespace-pre-wrap text-sm text-foreground-soft">{f.displayValue}</p>
            </div>
          ))}
        </section>
      )}
      {files.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-subtle-foreground">Documents</h3>
          {files.map((f) => (
            <DocumentPreview
              key={f.key}
              fileName={f.file!.fileName}
              inlineHref={f.file!.inlineHref}
              inlinePreviewable={f.file!.inlinePreviewable}
            />
          ))}
        </section>
      )}
    </div>
  );
}
