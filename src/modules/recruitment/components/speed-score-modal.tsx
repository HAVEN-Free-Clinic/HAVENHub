"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useTransition } from "react";
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
  // Opening snapshot: freeze the item set so live scoring never reindexes the
  // queue. A lazy useState initializer runs once at mount and ignores later prop
  // changes, which is the freeze we want and reads cleanly during render.
  const [snapshot] = useState(() => items);
  const [includeScored, setIncludeScored] = useState(false);
  const [index, setIndex] = useState(0);
  const [liveScores, setLiveScores] = useState<Record<string, number | null>>(() =>
    Object.fromEntries(items.map((i) => [i.applicationId, i.myScore])),
  );
  const [views, setViews] = useState<Record<string, ReviewApplicationView>>({});
  // Ids already loaded or in flight, so prefetch(next) + load(current) never
  // double-fire onLoad for the same applicant. A ref is read synchronously,
  // unlike a setState updater, so the dedupe is reliable.
  const loadedRef = useRef<Set<string>>(new Set());
  const [viewError, setViewError] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, startSave] = useTransition();
  // Applicant to keep in view across a queue-basis change (the show-scored
  // toggle), captured at toggle time before the queue recomputes.
  const keepIdRef = useRef<string | null>(null);

  const { queue, initialIndex } = useMemo(
    () => buildSpeedScoreQueue(snapshot, { includeScored }),
    [snapshot, includeScored],
  );

  // Reset position when the queue basis changes (open, or show-scored toggle).
  // Preserve the applicant captured at toggle time where it still exists in the
  // new queue; otherwise fall back to the first unscored (initialIndex).
  useEffect(() => {
    const keepId = keepIdRef.current;
    keepIdRef.current = null;
    const pos = keepId ? queue.findIndex((q) => q.applicationId === keepId) : -1;
    setIndex(pos >= 0 ? pos : initialIndex);
  }, [queue, initialIndex]);

  const total = snapshot.length;
  const scoredCount = Object.values(liveScores).filter((v) => v != null).length;
  const current = index < queue.length ? queue[index] : null;
  const done = current == null;
  const currentView = current ? views[current.applicationId] : undefined;

  const ensureLoaded = useCallback(
    async (applicationId: string, isCurrent: boolean) => {
      if (loadedRef.current.has(applicationId)) return;
      loadedRef.current.add(applicationId); // mark in flight so current + prefetch don't double-load
      try {
        const res = await onLoad(applicationId);
        if ("view" in res) {
          setViews((prev) => ({ ...prev, [applicationId]: res.view }));
        } else {
          loadedRef.current.delete(applicationId); // failed: allow a later retry
          if (isCurrent) setViewError(res.error);
        }
      } catch {
        // onLoad returns {error} only for handled cases; a Prisma failure in
        // getApplication/reviewScope/can, or a dropped request, REJECTS. Without this
        // the id stays marked loaded (no retry), views[id] is never set, and the
        // Spinner renders forever with no error banner (#48).
        loadedRef.current.delete(applicationId);
        if (isCurrent) setViewError("Could not load this application. Try again.");
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
    (nextIndex: number) => {
      setIndex((_i) => Math.min(Math.max(0, nextIndex), queue.length));
    },
    [queue.length],
  );

  const handleScore = useCallback(
    (value: number) => {
      // Refuse to score an application whose body never rendered (currentView unset --
      // e.g. its load failed): the 1-5 keys and the footer buttons must not commit a
      // committee score for content the reviewer never saw (#48).
      if (!current || isSaving || !currentView) return;
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
    [current, isSaving, currentView, comment, onScore],
  );

  // Global keyboard: 1-5 scores + advances; arrows navigate. Suppressed while a
  // form control is focused (comment field), while saving, and on the done screen.
  //
  // useLayoutEffect (not useEffect) so the listener re-registers with the fresh
  // isSaving/index closure SYNCHRONOUSLY at commit, before the browser paints the
  // advanced applicant. A passive effect would leave a window right after a save
  // where the stale listener (captured isSaving=true during the save) is still
  // installed, silently dropping the very next keypress -- exactly the rapid
  // "score, advance, score again" flow the keyboard grader is built for.
  useLayoutEffect(() => {
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

  function toggleShowScored(next: boolean) {
    // Capture the current applicant BEFORE the queue recomputes so the reset
    // effect keeps it in view instead of jumping to the first unscored.
    keepIdRef.current = current?.applicationId ?? null;
    setIncludeScored(next);
  }

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
                  disabled={isSaving || !currentView}
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
          <p className="text-sm text-muted-foreground">You&apos;ve scored {scoredCount} of {total} applicants.</p>
          {!includeScored && scoredCount < total && (
            <Button type="button" variant="outline" size="sm" onClick={() => toggleShowScored(true)}>
              Review scored applicants
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge>{current!.typeLabel}</Badge>
            <span className="min-w-0 break-words [overflow-wrap:anywhere] text-muted-foreground">{currentView?.email}</span>
            {currentView && currentView.departmentChoices.length > 0 && (
              <span className="min-w-0 break-words [overflow-wrap:anywhere] text-muted-foreground">Prefs: {currentView.departmentChoices.join(", ")}</span>
            )}
            <label className="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
              <Checkbox checked={includeScored} onChange={(e) => toggleShowScored(e.target.checked)} />
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
              // min-w-0 stops a long unbroken answer (a pasted NetID, a joined
              // multi-select) from widening its column into the neighbouring one.
              <div key={f.key} className="min-w-0 break-words [overflow-wrap:anywhere]">
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
            <div key={f.key} className="min-w-0 break-words [overflow-wrap:anywhere]">
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
