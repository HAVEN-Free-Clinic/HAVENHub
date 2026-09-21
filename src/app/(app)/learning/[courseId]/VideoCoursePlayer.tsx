"use client";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Lock, PlayCircle, RotateCcw } from "lucide-react";
import { Card } from "@/platform/ui/card";
import { Alert } from "@/platform/ui/alert";
import { Badge } from "@/platform/ui/badge";
import { Button } from "@/platform/ui/button";
import type { LearnerVideoCourse, LearnerVideoSection, SectionQuizResult } from "@/modules/learning/services/video-progress";
import { submitSectionQuizAction } from "../actions";

/** How often the player reports where it has reached while playing. The server
 *  credits at most the elapsed time between reports, so a longer interval would
 *  only make a stall cost the learner more. */
const HEARTBEAT_MS = 10_000;

type Props = { course: LearnerVideoCourse };

/**
 * A no-skip video course. The learner watches each section, then passes its
 * quiz, then the next section opens.
 *
 * The seek lock and the 1x playback rate here are a courtesy, not the rule:
 * the server credits watch time by real elapsed time (see engine/watch.ts), so
 * a learner who defeats this in the browser still cannot finish faster than
 * the video runs. What this must get right is never LOSING honest progress,
 * which is why it reports on pause and page-hide as well as on a timer.
 */
export function VideoCoursePlayer({ course }: Props) {
  const firstOpen = course.sections.find((s) => !s.state.passed) ?? course.sections[0];
  const [openId, setOpenId] = useState<string | null>(firstOpen?.id ?? null);

  if (course.sections.length === 0) {
    return <p className="text-sm text-muted-foreground">This course has no content yet. Check back soon.</p>;
  }

  return (
    <div className="space-y-4">
      {course.locked && (
        <Alert tone="warning">
          Your makeup is locked after too many failed attempts. Ask your director to reset it, then come back
          and try the quiz again.
        </Alert>
      )}
      {course.preview && (
        <Alert tone="info">
          Preview: you manage courses, so every section and quiz is open and you can skip through the
          videos. Nothing here is recorded, and taking a quiz does not count for anyone.
        </Alert>
      )}
      {course.complete && (
        <Alert tone="success">
          You have finished this course. It counts as your training for the term; you can rewatch it any time.
        </Alert>
      )}
      <ol className="space-y-4">
        {course.sections.map((section, i) => (
          <SectionCard
            key={section.id}
            courseId={course.id}
            index={i}
            section={section}
            locked={course.locked}
            reviewOnly={course.complete}
            preview={course.preview}
            open={openId === section.id}
            onOpen={() => setOpenId(section.id)}
          />
        ))}
      </ol>
    </div>
  );
}

function SectionCard({
  courseId,
  index,
  section,
  locked,
  reviewOnly,
  preview,
  open,
  onOpen,
}: {
  courseId: string;
  index: number;
  section: LearnerVideoSection;
  locked: boolean;
  reviewOnly: boolean;
  /** Manager looking at the course: the quiz is open without watching. */
  preview: boolean;
  open: boolean;
  onOpen: () => void;
}) {
  const [watched, setWatched] = useState(section.state.watched);
  const { unlocked, passed } = section.state;

  const status = passed ? (
    <Badge tone="success">Passed</Badge>
  ) : !unlocked ? (
    <Badge tone="default">Locked</Badge>
  ) : watched ? (
    <Badge tone="warning">Quiz to take</Badge>
  ) : (
    <Badge tone="default">To watch</Badge>
  );

  return (
    <li>
      <Card pad={false} className="overflow-hidden">
        {/* eslint-disable-next-line no-restricted-syntax -- a whole card header is the control here, not a button-shaped button */}
        <button type="button" onClick={onOpen} disabled={!unlocked} className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left disabled:cursor-not-allowed">
          <span className="flex min-w-0 items-center gap-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand-faint text-brand-fg">
              {passed ? (
                <Check aria-hidden className="h-5 w-5" />
              ) : unlocked ? (
                <PlayCircle aria-hidden className="h-5 w-5" />
              ) : (
                <Lock aria-hidden className="h-5 w-5" />
              )}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-base font-bold text-foreground">
                {index + 1}. {section.title}
              </span>
              <span className="mt-px block text-xs text-muted-foreground">
                {!unlocked ? "Pass the section before this one to open it." : `${Math.round(section.length / 60)} minute video, then a quiz`}
              </span>
            </span>
          </span>
          {status}
        </button>

        {open && unlocked && (
          <div className="border-t border-border p-4">
            <SectionVideo
              courseId={courseId}
              section={section}
              watched={watched}
              preview={preview}
              onWatched={() => setWatched(true)}
            />
            {watched && !passed && !locked && !reviewOnly && (
              <SectionQuiz courseId={courseId} section={section} />
            )}
            {watched && !passed && (locked || reviewOnly) && (
              <p className="mt-4 text-sm text-muted-foreground">The quiz is closed.</p>
            )}
          </div>
        )}
      </Card>
    </li>
  );
}

function SectionVideo({
  courseId,
  section,
  watched,
  preview,
  onWatched,
}: {
  courseId: string;
  section: LearnerVideoSection;
  watched: boolean;
  /** Manager preview: seeking and speed are unlocked, since the point is to
   *  reach the quiz, and the server records nothing either way. */
  preview: boolean;
  onWatched: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  // The furthest point the SERVER has credited, in seconds from the section's
  // start. The seek limit, and what a reload resumes from.
  const creditedRef = useRef(section.watchedSeconds);
  // The furthest point this page has played to, which runs slightly ahead of
  // the credited point between heartbeats.
  const reachedRef = useRef(section.watchedSeconds);
  const [error, setError] = useState<string | null>(null);
  // True while a heartbeat fetch is awaiting its response. One at a time: the
  // timer, a pause and a page-hide can all fire close together, and without
  // this they stack onto the same write.
  const sendingRef = useRef(false);
  // The same fact as the `watched` prop, in a ref, because the media event
  // handlers and the heartbeat close over it and must see the current value
  // without re-subscribing.
  const doneRef = useRef(watched);
  useEffect(() => {
    doneRef.current = watched;
  }, [watched]);

  const end = section.startSeconds + section.length;
  const relative = useCallback((absolute: number) => absolute - section.startSeconds, [section.startSeconds]);

  const send = useCallback(
    async (beacon: boolean) => {
      const body = JSON.stringify({ courseId, sectionId: section.id, reachedSeconds: reachedRef.current });
      if (beacon && typeof navigator.sendBeacon === "function") {
        // Survives the page going away, where a fetch would be cancelled.
        navigator.sendBeacon("/api/learning/video-heartbeat", new Blob([body], { type: "application/json" }));
        return;
      }
      if (sendingRef.current) return;
      sendingRef.current = true;
      try {
        const res = await fetch("/api/learning/video-heartbeat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          keepalive: true,
        });
        if (!res.ok) return;
        const result = (await res.json()) as { watchedSeconds: number; complete: boolean };
        creditedRef.current = Math.max(creditedRef.current, result.watchedSeconds);
        if (result.complete && !doneRef.current) {
          doneRef.current = true;
          onWatched();
        }
      } catch {
        // A dropped heartbeat is not worth interrupting playback: the next one
        // carries the same furthest point.
      } finally {
        sendingRef.current = false;
      }
    },
    [courseId, section.id, onWatched]
  );

  useEffect(() => {
    const id = setInterval(() => {
      const el = videoRef.current;
      if (el && !el.paused && !el.ended) void send(false);
    }, HEARTBEAT_MS);
    const onHide = () => {
      if (document.visibilityState === "hidden") void send(true);
    };
    const onPageHide = () => void send(true);
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [send]);

  // Start where they left off (or at the section's start once it is watched,
  // since a watched section is free to rewatch).
  const onLoadedMetadata = () => {
    const el = videoRef.current;
    if (!el) return;
    const resume = doneRef.current ? 0 : Math.min(creditedRef.current, section.length - 1);
    el.currentTime = section.startSeconds + Math.max(0, resume);
  };

  const onTimeUpdate = () => {
    const el = videoRef.current;
    if (!el) return;
    if (el.currentTime < section.startSeconds) {
      el.currentTime = section.startSeconds;
      return;
    }
    if (el.currentTime >= end) {
      el.pause();
      el.currentTime = end;
      reachedRef.current = section.length;
      void send(false);
      return;
    }
    reachedRef.current = Math.max(reachedRef.current, relative(el.currentTime));
  };

  // Seeking forward past what has been credited snaps back. Rewinding is fine.
  const onSeeking = () => {
    const el = videoRef.current;
    if (!el || doneRef.current || preview) return;
    const limit = section.startSeconds + Math.max(creditedRef.current, 0) + 1;
    if (el.currentTime > limit) {
      el.currentTime = limit;
      setError("You cannot skip ahead. The video has to play through.");
    }
  };

  const onRateChange = () => {
    const el = videoRef.current;
    if (el && !preview && el.playbackRate !== 1) el.playbackRate = 1;
  };

  return (
    <div>
      <video
        ref={videoRef}
        src={`/api/learning/video/${section.videoId}`}
        controls
        controlsList="nodownload noplaybackrate"
        disablePictureInPicture
        preload="metadata"
        playsInline
        className="w-full rounded-xl bg-black"
        onLoadedMetadata={onLoadedMetadata}
        onTimeUpdate={onTimeUpdate}
        onSeeking={onSeeking}
        onRateChange={onRateChange}
        onPause={() => void send(false)}
      >
        {section.hasCaptions && (
          <track kind="captions" src={`/api/learning/video/${section.videoId}/captions`} srcLang="en" label="English" default />
        )}
      </video>
      <p role="status" aria-live="polite" className="mt-2 text-xs text-muted-foreground">
        {watched ? "Watched in full." : ""}
      </p>
      {error && (
        <Alert tone="info" className="mt-2">
          {error}
        </Alert>
      )}
    </div>
  );
}

function SectionQuiz({ courseId, section }: { courseId: string; section: LearnerVideoSection }) {
  const router = useRouter();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [result, setResult] = useState<SectionQuizResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const resultRef = useRef<HTMLParagraphElement>(null);

  const allAnswered = section.questions.every((q) => answers[q.id]);
  const reviewing = result != null && !result.passed;
  const attemptsLeft = section.maxAttempts != null ? Math.max(0, section.maxAttempts - (result?.attemptsUsed ?? section.attemptsUsed)) : null;

  useEffect(() => {
    if (reviewing) resultRef.current?.focus();
  }, [reviewing]);

  function submit() {
    if (!allAnswered || pending) return;
    startTransition(async () => {
      const res = await submitSectionQuizAction({ courseId, sectionId: section.id, answers });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      // Passing opens the next section and may finish the course; a lock
      // changes the whole page. Either way the server owns what comes next.
      if (res.passed || res.locked) {
        router.refresh();
        return;
      }
      setResult(res);
    });
  }

  return (
    <div className="mt-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-base font-bold text-foreground">Quiz</p>
        <p className="text-xs text-muted-foreground">
          Pass at {section.passPercent}%
          {attemptsLeft != null ? ` · ${attemptsLeft} attempt${attemptsLeft === 1 ? "" : "s"} left` : ""}
        </p>
      </div>

      {reviewing && (
        <Card role="status" className="mt-3 flex items-center gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-warning text-white">
            <RotateCcw aria-hidden className="h-5 w-5" />
          </span>
          <div>
            <p ref={resultRef} tabIndex={-1} className="text-sm font-bold text-foreground outline-none">
              You scored {result?.percent}%
            </p>
            <p className="mt-0.5 text-sm text-foreground-soft">
              You need {section.passPercent}% to pass. Review the marked answers and try again.
            </p>
          </div>
        </Card>
      )}
      {error && (
        <Alert tone="error" className="mt-3">
          {error}
        </Alert>
      )}

      <div className="mt-3 space-y-5">
        {section.questions.map((q, i) => (
          <fieldset key={q.id} aria-labelledby={`q-${q.id}-label`}>
            <legend className="text-xs font-bold tracking-wide text-muted-foreground">Question {i + 1}</legend>
            <p id={`q-${q.id}-label`} className="mb-2 mt-1 text-sm font-semibold leading-snug text-foreground">
              {q.prompt}
            </p>
            <div className="flex flex-col gap-2">
              {q.options.map((o) => {
                const selected = answers[q.id] === o.value;
                const verdict = reviewing ? result?.verdictByKey[q.id] : undefined;
                const right = selected && verdict === "correct";
                const wrong = selected && verdict === "wrong";
                return (
                  <label key={o.value} className={optionClass({ selected, reviewing, right, wrong })}>
                    {/* eslint-disable-next-line no-restricted-syntax -- visually hidden radio inside a styled option row */}
                    <input type="radio" name={`q-${q.id}`} value={o.value} checked={selected} disabled={reviewing || pending} onChange={() => setAnswers((a) => ({ ...a, [q.id]: o.value }))} className="sr-only" />
                    <span className="min-w-0 flex-1 text-sm leading-snug">{o.label}</span>
                    {right && <span className="text-xs font-bold text-success-foreground">Correct</span>}
                    {wrong && <span className="text-xs font-bold text-critical-foreground">Not correct</span>}
                  </label>
                );
              })}
            </div>
          </fieldset>
        ))}
      </div>

      <div className="mt-4 flex items-center justify-between gap-3">
        <span role="status" aria-live="polite" className="text-xs text-muted-foreground">
          {pending
            ? "Grading your answers…"
            : reviewing
              ? "Review the marked answers, then try again."
              : allAnswered
                ? "All questions answered."
                : `Answer all ${section.questions.length} questions to submit.`}
        </span>
        {reviewing ? (
          <Button
            type="button"
            onClick={() => {
              const verdicts = result?.verdictByKey ?? {};
              setResult(null);
              setAnswers((a) => {
                const next = { ...a };
                for (const [key, verdict] of Object.entries(verdicts)) {
                  if (verdict === "wrong") delete next[key];
                }
                return next;
              });
            }}
          >
            <RotateCcw aria-hidden className="h-4 w-4" /> Try again
          </Button>
        ) : (
          <Button type="button" onClick={submit} disabled={!allAnswered || pending}>
            <Check aria-hidden className="h-4 w-4" /> Submit quiz
          </Button>
        )}
      </div>
    </div>
  );
}

function optionClass({
  selected,
  reviewing,
  right,
  wrong,
}: {
  selected: boolean;
  reviewing: boolean;
  right: boolean;
  wrong: boolean;
}): string {
  const base =
    "flex items-center gap-3 rounded-xl border px-3.5 py-3 transition has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-inset has-[:focus-visible]:ring-brand";
  if (right) return `${base} pointer-events-none border-success bg-success/10`;
  if (wrong) return `${base} pointer-events-none border-critical bg-critical-faint`;
  if (reviewing) return `${base} pointer-events-none border-border-strong bg-surface opacity-90`;
  if (selected) return `${base} cursor-pointer border-brand bg-brand-faint ring-1 ring-inset ring-brand`;
  return `${base} cursor-pointer border-border-strong bg-surface hover:border-brand hover:bg-brand-faint`;
}
