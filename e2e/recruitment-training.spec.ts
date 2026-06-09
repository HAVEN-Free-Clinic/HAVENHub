import { expect, test } from "@playwright/test";

test.setTimeout(120_000);

async function devLogin(page: import("@playwright/test").Page, email: string) {
  await page.goto("/login");
  await page.fill('input[name="email"]', email);
  await page.click('button:has-text("Dev sign in")');
  await page.waitForURL((url) => url.pathname === "/");
}

// NOTE: a promoted ACTIVE VOLUNTEER membership cannot be created through the UI
// in an e2e (onboarding needs a tokenized link the browser cannot read, per
// recruitment-onboarding.spec.ts). The volunteer self-serve quiz pass/fail/lock
// path and attendance completion are covered by integration tests
// (training.test.ts). This e2e covers the SRR-observable surface end to end:
// authoring a quiz, configuring + designating the training cycle, and the
// training roster rendering for the designated cycle.
test("training: author quiz, designate training cycle, roster renders", async ({ page }) => {
  await devLogin(page, "j.carney@yale.edu");

  // --- Create a VOLUNTEER cycle ---
  await page.goto("/recruitment/cycles/new");
  await page.fill('input[name="title"]', "Training E2E");
  const slug = `training-e2e-${Date.now()}`;
  await page.fill('input[name="publicSlug"]', slug);
  await page.fill('input[name="departments"]', "SRHD");
  await page.click('button:has-text("Create")');
  await page.waitForURL((url) => url.pathname.includes("/builder"));
  const cycleId = page.url().split("/cycles/")[1].split("/")[0];

  // --- Author a quiz: add a quiz section ---
  await page.goto(`/recruitment/cycles/${cycleId}/builder/quiz`);
  const addSectionForm = page.locator('form:has(button:has-text("Add quiz section"))');
  await addSectionForm.locator('input[name="title"]').fill("HIPAA Basics");
  await addSectionForm.locator('button:has-text("Add quiz section")').click();
  await expect(page.locator("h2").filter({ hasText: "HIPAA Basics" })).toBeVisible();

  // --- Add a question to that section ---
  const quizSection = page
    .locator("section")
    .filter({ has: page.locator("h2").filter({ hasText: "HIPAA Basics" }) })
    .first();
  const addQuestionForm = quizSection.locator('form:has(button:has-text("Add question"))');
  await addQuestionForm.locator('input[name="label"]').fill("What does HIPAA protect?");
  // Two option pairs; located by placeholder to disambiguate the repeated names.
  // exact:true keeps "value (e.g. a)" from also matching "correct value (e.g. a)".
  await addQuestionForm.getByPlaceholder("value (e.g. a)", { exact: true }).fill("phi");
  await addQuestionForm.getByPlaceholder("Answer A").fill("Patient info");
  await addQuestionForm.getByPlaceholder("value (e.g. b)", { exact: true }).fill("weather");
  await addQuestionForm.getByPlaceholder("Answer B").fill("The weather");
  await addQuestionForm.locator('input[name="correctValue"]').fill("phi");
  await addQuestionForm.locator('button:has-text("Add question")').click();
  await expect(quizSection.getByText("What does HIPAA protect?")).toBeVisible();

  // --- Overview: save quiz settings, then designate as this term's training ---
  await page.goto(`/recruitment/cycles/${cycleId}`);
  const quizSettingsForm = page.locator('form:has(button:has-text("Save quiz settings"))');
  await quizSettingsForm.locator('input[name="quizPassPercent"]').fill("80");
  await quizSettingsForm.locator('input[name="quizMaxAttempts"]').fill("3");
  await quizSettingsForm.locator('button:has-text("Save quiz settings")').click();

  // Designate as training; the button text flips after revalidation.
  await page.click('button:has-text("Use as this term\'s training")');
  await expect(
    page.locator("button:has-text(\"Stop using as this term's training\")")
  ).toBeVisible();

  // --- Training roster: designated cycle renders the roster, not the gate ---
  await page.goto(`/recruitment/cycles/${cycleId}/training`);
  await expect(page.locator("h1").filter({ hasText: "Training: Training E2E" })).toBeVisible();
  // Designation worked: the "not the term's training cycle" gate must be absent.
  await expect(page.getByText("This cycle is not the term's training cycle.")).toHaveCount(0);
  // The roster body renders for the designated cycle: either real volunteer
  // rows (seed data) or, with none in scope, the empty-state text. Assert that
  // at least one of the two is present (do not assert specific volunteer rows).
  const bodyRows = page.locator("table tbody tr");
  const emptyState = page.getByText("No active volunteers in scope.");
  await expect
    .poll(async () => (await bodyRows.count()) + (await emptyState.count()))
    .toBeGreaterThan(0);
});
