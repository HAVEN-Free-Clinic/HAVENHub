"use client";

import { useRef, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Check, FileText, RotateCcw, ClipboardList } from "lucide-react";
import type { TrainingTrack } from "@prisma/client";
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
  track,
  questions,
  passPercent,
  maxAttempts,
  attemptsUsed: initialAttemptsUsed,
  intake,
}: {
  track: TrainingTrack;
  questions: Question[];
  passPercent: number;
  maxAttempts: number;
  attemptsUsed: number;
  intake: MyTraining["intake"];
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [graded, setGraded] = useState<Graded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attemptsUsed, setAttemptsUsed] = useState(initialAttemptsUsed);
  const [pending, startTransition] = useTransition();

  const answeredCount = Object.keys(answers).length;
  const allAnswered = answeredCount === questions.length;
  const attemptsLeft = Math.max(0, maxAttempts - attemptsUsed);
  const reviewing = graded != null;

  function choose(key: string, value: string) {
    if (reviewing || pending) return;
    setAnswers((a) => ({ ...a, [key]: value }));
  }

  function tryAgain() {
    setGraded(null);
    setError(null);
    setAnswers({});
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
      const res = await gradeQuizAction({ track, answers, intake: intakePayload });
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
        <Card className="mb-5 flex items-center gap-4">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-warning text-white">
            <RotateCcw aria-hidden className="h-5 w-5" />
          </span>
          <div>
            <p className="text-[15px] font-bold text-foreground">You scored {graded.percent}%</p>
            <p className="mt-0.5 text-[13px] text-foreground-soft">
              You need {passPercent}% to pass. {attemptsLeft} attempt{attemptsLeft === 1 ? "" : "s"} left — review the
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
        <div className="flex items-center justify-between gap-4 border-b border-border px-[22px] py-[18px]">
          <div className="flex items-center gap-3">
            <span className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-[10px] bg-brand-faint text-brand-fg">
              <FileText aria-hidden className="h-[19px] w-[19px]" />
            </span>
            <div>
              <p className="text-[15px] font-bold text-foreground">Makeup quiz</p>
              <p className="mt-px text-[12.5px] text-muted-foreground">
                Pass at {passPercent}% · {attemptsLeft} attempt{attemptsLeft === 1 ? "" : "s"} left
              </p>
            </div>
          </div>
          <p className="shrink-0 text-[12.5px] font-semibold text-foreground-soft">
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

        <div className="px-[22px] pb-1 pt-2">
          {questions.map((q, i) => (
            <fieldset
              key={q.key}
              className="border-b border-border py-[18px] last:border-b-0"
            >
              <legend className="text-[11.5px] font-bold tracking-wide text-muted-foreground">Question {i + 1}</legend>
              <p className="mb-3 mt-1.5 text-[15px] font-semibold leading-snug text-foreground">{q.label}</p>
              <div className="flex flex-col gap-2.5">
                {q.options.map((o) => {
                  const sel = answers[q.key] === o.value;
                  const isCorrect = reviewing && graded!.correctByKey[q.key] === o.value;
                  const isWrong = reviewing && sel && !isCorrect;
                  return (
                    <label
                      key={o.value}
                      className={optionClass({ sel, reviewing, isCorrect, isWrong })}
                    >
                      <input
                        type="radio"
                        name={`q:${q.key}`}
                        value={o.value}
                        checked={sel}
                        disabled={reviewing || pending}
                        onChange={() => choose(q.key, o.value)}
                        className="sr-only"
                      />
                      <span className={dotClass({ sel, isCorrect })}>
                        <span className={dotFillClass({ sel, isCorrect })} />
                      </span>
                      <span className={`min-w-0 flex-1 text-sm leading-snug ${sel ? "font-semibold text-foreground" : "text-foreground"}`}>
                        {o.label}
                      </span>
                      {isCorrect && <span className="ml-auto text-xs font-bold text-success">Correct</span>}
                      {isWrong && <span className="ml-auto text-xs font-bold text-critical">Your answer</span>}
                    </label>
                  );
                })}
              </div>
            </fieldset>
          ))}
        </div>

        <div className="flex items-center justify-between gap-4 border-t border-border bg-muted px-[22px] py-[18px]">
          <span className="text-[12.5px] text-muted-foreground">
            {pending
              ? "Grading your answers…"
              : reviewing
                ? "Review the highlighted answers below."
                : allAnswered
                  ? "All questions answered — ready to submit."
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
      <Card pad={false} className="mt-[22px] overflow-hidden">
        <div className="flex items-center gap-3 border-b border-border px-[22px] py-[18px]">
          <span className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-[10px] bg-brand-faint text-brand-fg">
            <ClipboardList aria-hidden className="h-[19px] w-[19px]" />
          </span>
          <div>
            <p className="text-[15px] font-bold text-foreground">A few quick questions</p>
            <p className="mt-px text-[12.5px] text-muted-foreground">Helps us place you on shifts</p>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3.5 p-[22px] sm:grid-cols-2">
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
  const base = "flex items-center gap-3 rounded-xl border px-3.5 py-3 transition";
  if (isCorrect) return `${base} pointer-events-none border-success bg-green-50`;
  if (isWrong) return `${base} pointer-events-none border-critical bg-red-50`;
  if (reviewing) return `${base} pointer-events-none border-border-strong bg-surface opacity-90`;
  if (sel) return `${base} cursor-pointer border-brand bg-brand-faint ring-1 ring-inset ring-brand`;
  return `${base} cursor-pointer border-border-strong bg-surface hover:border-brand hover:bg-brand-faint`;
}

function dotClass({ sel, isCorrect }: { sel: boolean; isCorrect: boolean }): string {
  const base = "grid h-[19px] w-[19px] shrink-0 place-items-center rounded-full border-2";
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
