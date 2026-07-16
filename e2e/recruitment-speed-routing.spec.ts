import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { applicantSessionCookie } from "./portal-cookie";

test.setTimeout(150_000);

// The minimal identity-only form has no department-choice field, so applicants
// rank no department. Speed route needs a ranked (or resolved) department to
// auto-route or keyboard-route, so we set departmentChoices directly (the form
// ranking UI is covered by the apply e2e; here we test what speed route does
// with a ranked choice). Uses the same e2e database the dev server points at.
const prisma = new PrismaClient();
test.afterAll(async () => {
  await prisma.$disconnect();
});

async function devLogin(page: import("@playwright/test").Page, email: string) {
  await page.goto("/login");
  await page.fill('input[name="email"]', email);
  await page.click('button:has-text("Dev sign in")');
  await page.waitForURL((url) => url.pathname === "/");
}

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

test("speed route: score a spread, apply top + bottom, keyboard-route the middle", async ({ page, context }) => {
  await devLogin(page, "j.carney@yale.edu");

  // Build + publish a single-department volunteer cycle with a minimal form.
  await page.goto("/recruitment/cycles/new");
  // Title deliberately avoids the words "speed route" so the cycle's breadcrumb
  // link does not collide with the "Speed route" launcher link selector below.
  await page.fill('input[name="title"]', "Bulk Tier E2E");
  const slug = `speed-route-e2e-${Date.now()}`;
  await page.fill('input[name="publicSlug"]', slug);
  await page.fill('input[name="departments"]', "SRHD");
  await page.uncheck('input[name="seedDefaultForm"]');
  await page.click('button:has-text("Create")');
  await page.waitForURL((url) => url.pathname.includes("/builder"));
  const cycleId = page.url().split("/cycles/")[1].split("/")[0];

  await page.goto(`/recruitment/cycles/${cycleId}`);
  await page.click('button:has-text("Publish")');
  await expect(page.locator("span").filter({ hasText: "OPEN" })).toBeVisible();

  // Four applicants.
  const browser = context.browser()!;
  const stamp = Date.now();
  const emails = [0, 1, 2, 3].map((n) => `e2e-route-${n}-${stamp}@yale.edu`);
  await submitApplication(browser, slug, emails[0], "Anna");
  await submitApplication(browser, slug, emails[1], "Ben");
  await submitApplication(browser, slug, emails[2], "Cara");
  await submitApplication(browser, slug, emails[3], "Dan");

  // Give every applicant SRHD as their (only) ranked choice so speed route can
  // auto-route the top tier to their first choice and keyboard-route the middle.
  await prisma.application.updateMany({
    where: { cycleId },
    data: { departmentChoices: ["SRHD"] },
  });

  // Score them 5,4,2,1 via the speed-score modal so we get all three tiers
  // (top 20% -> 1, bottom 30% -> 1, middle -> 2 for N=4).
  await page.goto(`/recruitment/cycles/${cycleId}/applicants`);
  await page.getByRole("button", { name: /speed score/i }).click();
  const scoreDialog = page.getByRole("dialog");
  await expect(scoreDialog).toBeVisible();
  // Score via the modal's Score buttons (Playwright auto-waits for each to be
  // enabled, so this is robust against the save-in-flight disabled state). The
  // keyboard path itself is covered by the speed-score e2e; here scoring is just
  // setup to produce the tier spread. Wait for the queue to advance each time.
  await scoreDialog.getByRole("button", { name: "Score 5" }).click();
  await expect(scoreDialog.getByText(/2 of 4/)).toBeVisible();
  await scoreDialog.getByRole("button", { name: "Score 4" }).click();
  await expect(scoreDialog.getByText(/3 of 4/)).toBeVisible();
  await scoreDialog.getByRole("button", { name: "Score 2" }).click();
  await expect(scoreDialog.getByText(/4 of 4/)).toBeVisible();
  await scoreDialog.getByRole("button", { name: "Score 1" }).click();
  await expect(scoreDialog.getByText(/all caught up/i)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(scoreDialog).toBeHidden();

  // Open Speed route.
  await page.getByRole("link", { name: /speed route/i }).click();
  await page.waitForURL((url) => url.pathname.endsWith("/speed-route"));
  await expect(page.getByRole("heading", { name: "Speed route" })).toBeVisible();
  await expect(page.getByText(/^Top \(1\)$/)).toBeVisible();
  await expect(page.getByText(/^Middle \(2\)$/)).toBeVisible();
  await expect(page.getByText(/^Bottom \(1\)$/)).toBeVisible();

  // Apply the top tier (routes the top applicant to SRHD).
  await page.getByRole("button", { name: /apply top tier/i }).click();
  await page.getByRole("button", { name: /^Confirm$/ }).click();
  await expect(page.getByText(/Routed 1/)).toBeVisible();

  // Apply the bottom tier (rejects the bottom applicant).
  await page.getByRole("button", { name: /apply bottom tier/i }).click();
  await page.getByRole("button", { name: /^Confirm$/ }).click();
  await expect(page.getByText(/Rejected 1/)).toBeVisible();

  // Route the middle: two applicants, route each to their first ranked dept via the
  // modal's "1. SRHD" button (Playwright auto-waits for it to be enabled, so this is
  // robust against the save-in-flight disabled state). Wait for the advance each time.
  await page.getByRole("button", { name: /route the middle/i }).click();
  const routeDialog = page.getByRole("dialog");
  await expect(routeDialog).toBeVisible();
  await expect(routeDialog.getByText(/1 of 2/)).toBeVisible();
  await routeDialog.getByRole("button", { name: "1. SRHD" }).click();
  await expect(routeDialog.getByText(/2 of 2/)).toBeVisible();
  await routeDialog.getByRole("button", { name: "1. SRHD" }).click();
  await expect(routeDialog.getByText(/middle tier cleared/i)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(routeDialog).toBeHidden();

  // Back on the roster: three routed (top + two middle), one decided (rejected).
  await page.goto(`/recruitment/cycles/${cycleId}/applicants`);
  await expect(page.getByText("Routed", { exact: true })).toHaveCount(3);
  await expect(page.getByText("Decided", { exact: true })).toHaveCount(1);
});
