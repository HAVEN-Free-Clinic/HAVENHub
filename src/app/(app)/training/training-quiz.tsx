"use client";

import { useEffect, useRef, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Check, FileText, RotateCcw, ClipboardList } from "lucide-react";
import type { Track } from "@prisma/client";
import { gradeQuizAction, type QuizActionResult } from "./actions";
import type { MyTraining } from "@/modules/recruitment/services/training";
import { Card } from "@/platform/ui/card";
import { Alert } from "@/platform/ui/alert";
import { Field, Input, Textarea } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { Button } from "@/platform/ui/button";

type Question = MyTraining["questions"][number];

type Graded = Extract<QuizActionResult, { status: "graded" }>;

/** Interactive makeup quiz: selectable option cards, a progress bar, in-place
 *  grading with correct/wrong review, and retry. Passing or hitting the attempt
 *  cap refreshes the page so the server re-renders the clearance state. */
export function TrainingQuiz({
  termId,
  track,
  questions,
  gradedQuestionCount,
  passPercent,
  maxAttempts,
  attemptsUsed: initialAttemptsUsed,
  intake,
}: {
  termId: string;
  track: Track;
  questions: Question[];
  gradedQuestionCount: number;
  passPercent: number;
  maxAttempts: number;
  attemptsUsed: number;
  intake: MyTraining["intake"];
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  // Focus target for the fail result, so a screen-reader user is not left on <body>
  // with no announcement after grading this mandatory clearance step (#28).
  const resultHeadingRef = useRef<HTMLParagraphElement>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [graded, setGraded] = useState<Graded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attemptsUsed, setAttemptsUsed] = useState(initialAttemptsUsed);
  const [pending, startTransition] = useTransition();
  const fieldsetRefs = useRef<Record<string, HTMLFieldSetElement | null>>({});

  const answeredCount = Object.keys(answers).length;
  const allAnswered = answeredCount === questions.length;
  const attemptsLeft = Math.max(0, maxAttempts - attemptsUsed);
  const reviewing = graded != null;

  // After a failed attempt renders its result card, move focus to the score heading
  // (a persistent aria-live status line below also announces the transition), so the
  // reviewer hears the outcome and their next Tab starts at the result, not the top of
  // the document (#28). Pass/lock take the router.refresh path and re-render the page.
  useEffect(() => {
    if (graded && !graded.passed) resultHeadingRef.current?.focus();
  }, [graded]);

  // A track's makeup quiz can have zero questions (e.g. still being authored), or it
  // can have questions that nobody has keyed with a correct answer yet, which is just
  // as unpassable (gradeQuiz never passes a quiz with zero graded questions). With
  // either, there is nothing gradable to take: the progress bar would divide by zero
  // (NaN width) in the no-questions case, an empty answer set would read as "all
  // answered" and enable Submit, and submitting only throws server-side. The learner
  // cannot tell the two cases apart and should not have to, so show one explanatory
  // notice instead of the quiz form.
  if (questions.length === 0 || gradedQuestionCount === 0) {
    return (
      <Card className="flex items-start gap-4">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand-faint text-brand-fg">
          <ClipboardList aria-hidden className="h-5 w-5" />
        </span>
        <div>
          <p className="text-base font-bold text-foreground">Makeup quiz not ready yet</p>
          <p className="mt-0.5 text-sm text-foreground-soft">
            This training&apos;s quiz has not been finished yet, so there is nothing to take. Please contact
            your coordinator so they can complete it, then check back here.
          </p>
        </div>
      </Card>
    );
  }

  function choose(key: string, value: string) {
    if (reviewing || pending) return;
    setAnswers((a) => ({ ...a, [key]: value }));
  }

  function tryAgain() {
    const verdicts = graded?.verdictByKey ?? {};
    setGraded(null);
    setError(null);
    setAnswers((a) => {
      const next = { ...a };
      for (const [key, verdict] of Object.entries(verdicts)) {
        if (verdict === "wrong") delete next[key];
      }
      return next;
    });
    // Land the reader on the first question they have to redo. Without this,
    // focus falls to <body> near the bottom of a very long page and the next
    // Tab starts from the top of the document. The fieldset itself does not
    // unmount across this state change (only its styling does), so focusing it
    // here rather than in a post-render effect is safe, and it means nothing
    // happens if nothing was wrong (retryFocusKey would just be undefined).
    const retryFocusKey = questions.find((q) => verdicts[q.key] === "wrong")?.key;
    if (retryFocusKey) {
      const el = fieldsetRefs.current[retryFocusKey];
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
      el?.focus({ preventScroll: true });
    }
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!allAnswered || pending || reviewing) return;
    const fd = new FormData(formRef.current!);
    const intakePayload = {
      minShiftsWanted: (fd.get("minShiftsWanted") as string) || null,
      additionalShiftAvailability: (fd.get("additionalShiftAvailability") as string) || null,
      feedback: (fd.get("feedback") as string) || null,
    };
    startTransition(async () => {
      const res = await gradeQuizAction({ termId, track, answers, intake: intakePayload });
      if (res.status === "error") {
        setError(res.message);
        return;
      }
      // Passing clears training; the final failed attempt locks it. Either way the
      // server owns the new clearance state, so refresh and let the page re-render.
      if (res.passed || res.locked) {
        window.scrollTo({ top: 0, behavior: "smooth" });
        router.refresh();
        return;
      }
      setAttemptsUsed(res.attemptsUsed);
      setGraded(res);
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }

  return (
    <form ref={formRef} onSubmit={handleSubmit}>
      {/* Fail result banner (pass/lock refresh the page instead) */}
      {graded && !graded.passed && (
        <Card role="status" className="mb-5 flex items-center gap-4">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-warning text-white">
            <RotateCcw aria-hidden className="h-5 w-5" />
          </span>
          <div>
            <p ref={resultHeadingRef} tabIndex={-1} className="text-base font-bold text-foreground outline-none">You scored {graded.percent}%</p>
            <p className="mt-0.5 text-sm text-foreground-soft">
              You need {passPercent}% to pass. {attemptsLeft} attempt{attemptsLeft === 1 ? "" : "s"} left. Review the
              highlighted answers and try again.
            </p>
          </div>
        </Card>
      )}

      {error && (
        <Alert tone="error" className="mb-5">
          {error}
        </Alert>
      )}

      {/* Quiz card */}
      <Card pad={false} className="overflow-hidden">
        <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-4">
          <div className="flex items-center gap-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand-faint text-brand-fg">
              <FileText aria-hidden className="h-5 w-5" />
            </span>
            <div>
              <p className="text-base font-bold text-foreground">Makeup quiz</p>
              <p className="mt-px text-xs text-muted-foreground">
                Pass at {passPercent}% · {attemptsLeft} attempt{attemptsLeft === 1 ? "" : "s"} left
              </p>
            </div>
          </div>
          <p className="shrink-0 text-xs font-semibold text-foreground-soft">
            {answeredCount} of {questions.length} answered
          </p>
        </div>

        {/* Progress */}
        <div className="h-[3px] bg-muted-strong">
          <div
            className="h-full bg-brand transition-[width] duration-300 ease-out"
            style={{ width: `${(answeredCount / questions.length) * 100}%` }}
          />
        </div>

        <div className="px-5 pb-1 pt-2">
          {questions.map((q, i) => (
            <fieldset
              key={q.key}
              ref={(el) => {
                fieldsetRefs.current[q.key] = el;
              }}
              tabIndex={-1}
              aria-labelledby={`quiz-q${i}-legend quiz-q${i}-label`}
              className="border-b border-border py-4 outline-none last:border-b-0"
            >
              <legend id={`quiz-q${i}-legend`} className="text-xs font-bold tracking-wide text-muted-foreground">Question {i + 1}</legend>
              <p id={`quiz-q${i}-label`} className="mb-3 mt-1.5 text-base font-semibold leading-snug text-foreground">{q.label}</p>
              <div className="flex flex-col gap-2.5">
                {q.options.map((o) => {
                  const sel = answers[q.key] === o.value;
                  const verdict = reviewing ? graded!.verdictByKey[q.key] : undefined;
                  const isCorrect = sel && verdict === "correct";
                  const isWrong = sel && verdict === "wrong";
                  return (
                    <label
                      key={o.value}
                      className={optionClass({ sel, reviewing, isCorrect, isWrong })}
                    >
                      {/* eslint-disable-next-line no-restricted-syntax -- visually-hidden radio inside custom styled label, sr-only class required for option styling */}
                      <input type="radio" name={`q:${q.key}`} value={o.value} checked={sel} disabled={reviewing || pending} onChange={() => choose(q.key, o.value)} className="sr-only" />
                      <span className={dotClass({ sel, isCorrect })}>
                        <span className={dotFillClass({ sel, isCorrect })} />
                      </span>
                      <span className={`min-w-0 flex-1 text-sm leading-snug ${sel ? "font-semibold text-foreground" : "text-foreground"}`}>
                        {o.label}
                      </span>
                      {isCorrect && <span className="ml-auto text-xs font-bold text-success-foreground">Correct</span>}
                      {isWrong && <span className="ml-auto text-xs font-bold text-critical-foreground">Not correct</span>}
                    </label>
                  );
                })}
              </div>
            </fieldset>
          ))}
        </div>

        <div className="flex items-center justify-between gap-4 border-t border-border bg-muted px-5 py-4">
          {/* Persistent live region: it is always in the DOM, so a screen reader
              announces each transition ("Grading your answers…" -> "Review the
              highlighted answers below.") without relying on a freshly-mounted node (#28). */}
          <span role="status" aria-live="polite" className="text-xs text-muted-foreground">
            {pending
              ? "Grading your answers…"
              : reviewing
                ? "Review the highlighted answers below."
                : allAnswered
                  ? "All questions answered. Ready to submit."
                  : `Answer all ${questions.length} questions to submit.`}
          </span>
          {reviewing ? (
            <Button type="button" onClick={tryAgain}>
              <RotateCcw aria-hidden className="h-4 w-4" /> Try again
            </Button>
          ) : (
            <Button type="submit" disabled={!allAnswered || pending}>
              <Check aria-hidden className="h-4 w-4" /> Submit quiz
            </Button>
          )}
        </div>
      </Card>

      {/* Intake */}
      <Card pad={false} className="mt-5 overflow-hidden">
        <div className="flex items-center gap-3 border-b border-border px-5 py-4">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand-faint text-brand-fg">
            <ClipboardList aria-hidden className="h-5 w-5" />
          </span>
          <div>
            <p className="text-base font-bold text-foreground">A few quick questions</p>
            <p className="mt-px text-xs text-muted-foreground">Helps us place you on shifts</p>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3.5 p-5 sm:grid-cols-2">
          <Field label="Minimum shifts wanted this term">
            <Select name="minShiftsWanted" defaultValue={intake.minShiftsWanted ?? "4"}>
              {[2, 3, 4, 5, 6, 8].map((n) => (
                <option key={n} value={String(n)}>
                  {n} shifts
                </option>
              ))}
            </Select>
          </Field>
          <div className="sm:col-span-2">
            <Field label="Additional shift availability" hint="Optional">
              <Input
                name="additionalShiftAvailability"
                defaultValue={intake.additionalShiftAvailability ?? ""}
                placeholder="e.g. Available most Saturday mornings, some weekday evenings"
              />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Field label="Feedback or questions" hint="Optional">
              <Textarea
                name="feedback"
                defaultValue={intake.feedback ?? ""}
                placeholder="Anything you'd like the directors to know?"
                className="min-h-[78px] resize-y"
              />
            </Field>
          </div>
        </div>
      </Card>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

function optionClass({
  sel,
  reviewing,
  isCorrect,
  isWrong,
}: {
  sel: boolean;
  reviewing: boolean;
  isCorrect: boolean;
  isWrong: boolean;
}): string {
  const base =
    "flex items-center gap-3 rounded-xl border px-3.5 py-3 transition has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-inset has-[:focus-visible]:ring-brand";
  if (isCorrect) return `${base} pointer-events-none border-success bg-success/10`;
  if (isWrong) return `${base} pointer-events-none border-critical bg-critical-faint`;
  if (reviewing) return `${base} pointer-events-none border-border-strong bg-surface opacity-90`;
  if (sel) return `${base} cursor-pointer border-brand bg-brand-faint ring-1 ring-inset ring-brand`;
  return `${base} cursor-pointer border-border-strong bg-surface hover:border-brand hover:bg-brand-faint`;
}

function dotClass({ sel, isCorrect }: { sel: boolean; isCorrect: boolean }): string {
  const base = "grid h-5 w-5 shrink-0 place-items-center rounded-full border-2";
  if (isCorrect) return `${base} border-success`;
  if (sel) return `${base} border-brand`;
  return `${base} border-border-strong`;
}

function dotFillClass({ sel, isCorrect }: { sel: boolean; isCorrect: boolean }): string {
  const base = "h-[9px] w-[9px] rounded-full transition-transform";
  if (isCorrect) return `${base} scale-100 bg-success`;
  if (sel) return `${base} scale-100 bg-brand`;
  return `${base} scale-0 bg-brand`;
}
