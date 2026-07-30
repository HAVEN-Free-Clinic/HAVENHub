// @vitest-environment jsdom
/**
 * Interaction tests for the makeup quiz's review-screen marking and "Try again"
 * behavior -- the exact defects this branch exists to fix: a failed attempt used
 * to hand the learner the whole answer key, and "Try again" wiped every answer,
 * including the correct ones. This needs real DOM interaction (click a radio,
 * submit, click "Try again"), so it follows combobox.test.tsx's createRoot + act
 * harness, the one component test in the repo that drives state changes rather
 * than just rendering static markup (condition-editor.test.tsx and the
 * onboarding-preview test only call renderToStaticMarkup, which can't exercise a
 * click/submit/retry cycle).
 *
 * gradeQuizAction is a "use server" export; no existing component test mocks a
 * sibling server action (onboard-form.test.tsx imports its real "./actions" but
 * never calls the action, since it only renders static markup), so this stubs it
 * directly with vi.mock, same as combobox.test.tsx stubs missing jsdom APIs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { QuizActionResult } from "./actions";

// jsdom doesn't implement layout, so scrollIntoView (used to keep the retry
// target visible) is missing; stub it, same as jsdom consumers elsewhere in the
// repo. scrollTo (used to bring the result banner into view) exists but logs a
// "not implemented" virtual-console error when called, so stub it too.
if (!window.HTMLElement.prototype.scrollIntoView) {
  window.HTMLElement.prototype.scrollIntoView = () => {};
}
window.scrollTo = () => {};
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("./actions", () => ({ gradeQuizAction: vi.fn() }));

const { TrainingQuiz } = await import("./training-quiz");
const { gradeQuizAction } = await import("./actions");

const questions = [
  { key: "q1", label: "Question one", options: [{ value: "a", label: "Option A" }, { value: "b", label: "Option B" }] },
  { key: "q2", label: "Question two", options: [{ value: "x", label: "Option X" }, { value: "y", label: "Option Y" }] },
];

const intake = { additionalShiftAvailability: null, minShiftsWanted: null, feedback: null };

let mounted: { container: HTMLDivElement; root: Root } | null = null;

function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <TrainingQuiz
        termId="term1"
        track="VOLUNTEER"
        questions={questions}
        gradedQuestionCount={2}
        passPercent={100}
        maxAttempts={3}
        attemptsUsed={0}
        intake={intake}
      />,
    );
  });
  mounted = { container, root };
  return container;
}

function radio(container: HTMLElement, key: string, value: string): HTMLInputElement {
  return container.querySelector(`input[name="q:${key}"][value="${value}"]`) as HTMLInputElement;
}

function optionLabel(container: HTMLElement, key: string, value: string): HTMLLabelElement {
  return radio(container, key, value).closest("label") as HTMLLabelElement;
}

function choose(container: HTMLElement, key: string, value: string) {
  act(() => {
    radio(container, key, value).click();
  });
}

async function submit(container: HTMLElement) {
  const form = container.querySelector("form")!;
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    // gradeQuizAction is awaited once inside the transition; give the resolved
    // mock's continuation a couple of microtask turns to run and call setGraded.
    await Promise.resolve();
    await Promise.resolve();
  });
}

function tryAgain(container: HTMLElement) {
  const button = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Try again"))!;
  act(() => {
    button.click();
  });
}

beforeEach(() => {
  vi.mocked(gradeQuizAction).mockReset();
});

afterEach(() => {
  if (mounted) {
    act(() => {
      mounted!.root.unmount();
    });
    mounted.container.remove();
    mounted = null;
  }
});

describe("TrainingQuiz review marking", () => {
  it("marks only the learner's selected wrong option, leaving the option they did not pick unmarked", async () => {
    vi.mocked(gradeQuizAction).mockResolvedValue({
      status: "graded", passed: false, percent: 50, attemptsUsed: 1, locked: false,
      verdictByKey: { q1: "wrong", q2: "correct" },
    } satisfies QuizActionResult);

    const container = mount();
    choose(container, "q1", "a");
    choose(container, "q2", "y");
    await submit(container);

    // The learner's own (wrong) pick is marked...
    expect(optionLabel(container, "q1", "a").textContent).toContain("Not correct");
    // ...but the option they never touched carries no verdict at all, even
    // though the review screen knows it was the right answer. This is the
    // defect this branch fixes: a failed attempt used to reveal the whole
    // answer key instead of marking only what the learner actually chose.
    expect(optionLabel(container, "q1", "b").textContent).not.toContain("Correct");
    expect(optionLabel(container, "q1", "b").textContent).not.toContain("Not correct");
  });

  it("leaves a question absent from verdictByKey (unkeyed) completely unmarked, even though it was answered", async () => {
    vi.mocked(gradeQuizAction).mockResolvedValue({
      status: "graded", passed: false, percent: 50, attemptsUsed: 1, locked: false,
      // q2 has no entry at all: an unkeyed question, not merely a wrong one.
      verdictByKey: { q1: "correct" },
    } satisfies QuizActionResult);

    const container = mount();
    choose(container, "q1", "a");
    choose(container, "q2", "x");
    await submit(container);

    expect(optionLabel(container, "q2", "x").textContent).not.toContain("Correct");
    expect(optionLabel(container, "q2", "x").textContent).not.toContain("Not correct");
    expect(optionLabel(container, "q2", "y").textContent).not.toContain("Correct");
    expect(optionLabel(container, "q2", "y").textContent).not.toContain("Not correct");
  });
});

describe('TrainingQuiz "Try again"', () => {
  it("preserves the answer marked correct and clears only the one marked wrong", async () => {
    vi.mocked(gradeQuizAction).mockResolvedValue({
      status: "graded", passed: false, percent: 50, attemptsUsed: 1, locked: false,
      verdictByKey: { q1: "correct", q2: "wrong" },
    } satisfies QuizActionResult);

    const container = mount();
    choose(container, "q1", "a");
    choose(container, "q2", "x");
    await submit(container);

    // Sanity check: both selections landed and the review screen is up (radios
    // disabled while reviewing).
    expect(radio(container, "q1", "a").checked).toBe(true);
    expect(radio(container, "q2", "x").checked).toBe(true);
    expect(radio(container, "q1", "a").disabled).toBe(true);

    tryAgain(container);

    // The correct answer survives...
    expect(radio(container, "q1", "a").checked).toBe(true);
    // ...but the wrong one is cleared, not just left displayed as wrong: this is
    // the defect this branch fixes ("Try again" used to wipe every answer,
    // including the correct ones, forcing a full redo).
    expect(radio(container, "q2", "x").checked).toBe(false);
    expect(radio(container, "q2", "y").checked).toBe(false);
    // Back in edit mode: radios are enabled again.
    expect(radio(container, "q1", "a").disabled).toBe(false);
  });
});

describe("TrainingQuiz focus management", () => {
  it("moves focus to the result heading after a failed attempt, so a screen-reader user hears the outcome", async () => {
    vi.mocked(gradeQuizAction).mockResolvedValue({
      status: "graded", passed: false, percent: 50, attemptsUsed: 1, locked: false,
      verdictByKey: { q1: "wrong", q2: "correct" },
    } satisfies QuizActionResult);

    const container = mount();
    choose(container, "q1", "a");
    choose(container, "q2", "y");
    await submit(container);

    const heading = Array.from(container.querySelectorAll("p")).find((p) => p.textContent?.includes("You scored"));
    expect(heading).toBeTruthy();
    expect(document.activeElement).toBe(heading);
  });
});
