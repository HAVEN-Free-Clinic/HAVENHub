import { expect, test } from "@playwright/test";
import { applicantSessionCookie } from "./portal-cookie";
import { selectDepartments } from "./recruitment-helpers";

test.setTimeout(120_000);

async function devLogin(page: import("@playwright/test").Page, email: string) {
  await page.goto("/login");
  await page.fill('input[name="email"]', email);
  await page.click('button:has-text("Dev sign in")');
  await page.waitForURL((url) => url.pathname === "/");
}

// Submits one public application as a verified portal applicant. The apply
// wizard is multi-step: fill the identity section while it is visible, advance
// with Continue, and Submit only on the final Review step.
async function submitApplication(
  browser: import("@playwright/test").Browser,
  slug: string,
  applicantEmail: string,
  firstName: string,
) {
  const ctx = await browser.newContext();
  await ctx.addCookies([applicantSessionCookie(applicantEmail)]);
  const apply = await ctx.newPage();
  await apply.goto(`/apply/${slug}`);
  const submit = apply.getByRole("button", { name: "Submit application" });
  const continueBtn = apply.getByRole("button", { name: "Continue" });
  const firstNameField = apply.locator('input[name="first_name"]');
  for (let i = 0; i < 8; i++) {
    // Settle on the step before acting: non-review steps show Continue, Review
    // shows Submit. Avoids the flaky blind-click of a Continue already replaced by
    // Submit on Review (which hung the whole test).
    await expect(continueBtn.or(submit)).toBeVisible({ timeout: 45_000 });
    if (await submit.isVisible().catch(() => false)) break;
    if (await firstNameField.isVisible().catch(() => false)) {
      await firstNameField.fill(firstName);
      await apply.fill('input[name="last_name"]', "X");
      await apply.fill('input[name="email"]', applicantEmail);
    }
    await continueBtn.click();
  }
  await expect(submit).toBeVisible();
  await submit.click();
  await expect(apply.getByText(/your application was received/i)).toBeVisible();
  await ctx.close();
}

test("speed score: score two applicants with the keyboard and see the roster update", async ({ page, context }) => {
  await devLogin(page, "j.carney@yale.edu");

  // --- Build + publish a volunteer cycle with a minimal identity-only form ---
  await page.goto("/recruitment/cycles/new");
  await page.fill('input[name="title"]', "Speed Score E2E");
  const slug = `speed-score-e2e-${Date.now()}`;
  await page.fill('input[name="publicSlug"]', slug);
  await selectDepartments(page, ["SRHD"]);
  // Build the form ourselves (minimal name+email seed) so the apply wizard stays
  // a simple identity-only flow; the default form has required files + subcommittees.
  await page.uncheck('input[name="seedDefaultForm"]');
  await page.click('button:has-text("Create")');
  await page.waitForURL((url) => url.pathname.includes("/builder"));
  const cycleId = page.url().split("/cycles/")[1].split("/")[0];

  await page.goto(`/recruitment/cycles/${cycleId}`);
  await page.click('button:has-text("Publish")');
  await expect(page.locator("span").filter({ hasText: "OPEN" })).toBeVisible();

  // --- Submit two applications so the queue advances between them ---
  const browser = context.browser()!;
  const emailOne = `e2e-speed-one-${Date.now()}@yale.edu`;
  const emailTwo = `e2e-speed-two-${Date.now()}@yale.edu`;
  await submitApplication(browser, slug, emailOne, "Speedy");
  await submitApplication(browser, slug, emailTwo, "Scorer");

  // --- Open the speed score modal from the applicants roster ---
  await page.goto(`/recruitment/cycles/${cycleId}/applicants`);
  await page.getByRole("button", { name: /speed score/i }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  // The first applicant's condensed view is shown (At a glance heading, "1 of 2").
  await expect(dialog.getByText(/at a glance/i)).toBeVisible();
  await expect(dialog.getByText(/1 of 2/)).toBeVisible();

  // Press 3 to score the first applicant and advance.
  await page.keyboard.press("3");
  await expect(dialog.getByText(/2 of 2/)).toBeVisible();
  await expect(dialog.getByText(/at a glance/i)).toBeVisible();

  // Score the second (and last) applicant; the queue is exhausted and the done
  // screen appears.
  await page.keyboard.press("4");
  await expect(dialog.getByText(/all caught up/i)).toBeVisible();
  await expect(dialog.getByText(/scored 2 of 2 applicants/i)).toBeVisible();

  // Close (Esc) and confirm the roster reflects the committee averages: the
  // launcher calls router.refresh() on close, so the roster's "Committee avg"
  // column should no longer read "-" for either applicant.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByText(/^3\.0 · 1$/)).toBeVisible();
  await expect(page.getByText(/^4\.0 · 1$/)).toBeVisible();
});
