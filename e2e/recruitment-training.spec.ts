import { expect, test } from "@playwright/test";
import { devLogin } from "./auth";
import { prisma } from "./fixtures";
import { selectDepartments } from "./recruitment-helpers";

test.setTimeout(120_000);

// NOTE: a promoted ACTIVE VOLUNTEER membership cannot be created through the UI
// in an e2e (onboarding needs a tokenized link the browser cannot read, per
// recruitment-onboarding.spec.ts). The volunteer self-serve quiz pass/fail/lock
// path and attendance completion are covered by integration tests
// (training.test.ts). This e2e covers the SRR-observable surface end to end:
// authoring a quiz, configuring + designating the training cycle, and the
// training roster rendering for the designated cycle.
test("training: author quiz, designate training cycle, roster renders", async ({ page }) => {
  await devLogin(page, "j.carney@yale.edu");

  // --- Create a DIRECTOR cycle (not VOLUNTEER, to avoid activating the volunteer
  //     onboarding gate for dev.volunteer@yale.edu in concurrent test runs) ---
  await page.goto("/recruitment/cycles/new");
  await page.fill('input[name="title"]', "Training E2E");
  const slug = `training-e2e-${Date.now()}`;
  await page.fill('input[name="publicSlug"]', slug);
  // Switch to Director track so this designation doesn't affect volunteer onboarding.
  await page.selectOption('select[name="track"]', "DIRECTOR");
  await selectDepartments(page, ["ITCM"]);
  await page.click('button:has-text("Create")');
  await page.waitForURL((url) => url.pathname.includes("/builder"));
  const cycleId = page.url().split("/cycles/")[1].split("/")[0];

  // --- Author a quiz: add a quiz section ---
  // The quiz builder uses controlled React state for the section title (no form/name attr).
  // The Field label wraps the input, so getByLabel works via implicit association.
  await page.goto(`/recruitment/cycles/${cycleId}/builder/quiz`);
  await page.getByLabel("Quiz section title").fill("HIPAA Basics");
  await page.getByRole("button", { name: "Add quiz section" }).click();
  await expect(page.locator("h2").filter({ hasText: "HIPAA Basics" })).toBeVisible();

  // --- Add a question to that section ---
  // "Add question" creates a SINGLE_SELECT field via server action + router.refresh().
  // The label input is an uncontrolled input that saves on blur (no name attr).
  const quizSection = page
    .locator("section")
    .filter({ has: page.locator("h2").filter({ hasText: "HIPAA Basics" }) })
    .first();
  await quizSection.getByRole("button", { name: "Add question" }).click();
  // Wait for the question card to appear after startTransition + refresh
  const questionInput = quizSection.getByLabel("Question");
  await expect(questionInput).toBeVisible({ timeout: 15000 });
  // Set the label via fill + blur (saves onBlur via startTransition + refresh).
  // After fill the input holds "What does HIPAA protect?"; verify with toHaveValue
  // (it's an uncontrolled input, so the value is not in the DOM as visible text).
  await questionInput.fill("What does HIPAA protect?");
  await questionInput.blur();
  // Verify the fill took, which the comment above asks for. This does NOT settle the
  // blur's updateFieldAction + refresh(): the input is uncontrolled and fill() already
  // set its value, so this matches on the first poll while the refresh is still in
  // flight. There is no DOM signal for that refresh landing (quiz-builder.tsx discards
  // useTransition's isPending, and the label input is uncontrolled), so the ordering
  // against the "Add option" refresh below rests on the generous toBeVisible and
  // toBeChecked timeouts plus CI's retries: 1.
  await expect(questionInput).toHaveValue("What does HIPAA protect?");

  // A newly added question has zero options and no answer key. The designation
  // guard (setTrainingCycle -> countGradedQuestions) refuses to designate a
  // cycle whose quiz has no keyed question, so give this one an option and
  // mark it correct before designating below, or the "Use as this term's
  // training" click further down throws TrainingStateError and the button
  // never flips.
  await quizSection.getByRole("button", { name: "Add option" }).click();
  // Wait for the option's radio to appear after startTransition + refresh,
  // same convention as the question card wait above, so it exists before we
  // try to check it.
  const correctAnswerRadio = quizSection.getByRole("radio", { name: "Correct answer" });
  await expect(correctAnswerRadio).toBeVisible({ timeout: 15000 });
  await correctAnswerRadio.click();
  // The radio is server-controlled (checked={markCorrect.value === item.value}),
  // so it only reads as checked once correctValue is saved and the refresh lands.
  await expect(correctAnswerRadio).toBeChecked({ timeout: 15000 });

  // --- Overview: save quiz settings, then designate as this term's training ---
  await page.goto(`/recruitment/cycles/${cycleId}`);
  const quizSettingsForm = page.locator('form:has(button:has-text("Save quiz settings"))');
  await quizSettingsForm.locator('input[name="quizPassPercent"]').fill("80");
  await quizSettingsForm.locator('input[name="quizMaxAttempts"]').fill("3");
  await quizSettingsForm.locator('button:has-text("Save quiz settings")').click();

  // Wait for the quiz settings save to fully revalidate before clicking designate.
  await expect(page.locator('button:has-text("Use as this term\'s training")')).toBeVisible({ timeout: 15000 });
  // Designate as training; the button text flips after revalidation.
  await page.click('button:has-text("Use as this term\'s training")');
  // Under concurrent test load the RSC re-render can take several seconds.
  await expect(
    page.locator("button:has-text(\"Stop using as this term's training\")")
  ).toBeVisible({ timeout: 15000 });

  // --- Training roster: designated cycle renders the roster, not the gate ---
  await page.goto(`/recruitment/cycles/${cycleId}/training`);
  // PageHeader renders title="Training" and description=cycle.title separately;
  // the h1 text is just "Training", not "Training: Training E2E"
  await expect(page.getByRole("heading", { name: "Training" })).toBeVisible();
  // Designation worked: the "not the term's training cycle" gate must be absent.
  await expect(page.getByText("This cycle is not the term's training cycle.")).toHaveCount(0);
  // The roster body renders for the designated cycle: either real director
  // rows (seed data) or, with none in scope, the empty-state text. Assert that
  // at least one of the two is present (do not assert specific director rows).
  const bodyRows = page.locator("table tbody tr");
  const emptyState = page.getByText("No active directors in scope.");
  await expect
    .poll(async () => (await bodyRows.count()) + (await emptyState.count()))
    .toBeGreaterThan(0);

  // Cleanup: undesignate this cycle so it does not affect other test runs.
  // A stale DIRECTOR designation is benign (no seeded directors to block), but
  // consistent cleanup prevents cross-run interference.
  await prisma.recruitmentCycle.update({
    where: { id: cycleId },
    data: { isTermTraining: false },
  });
});
