import { expect, test, type Page } from "@playwright/test";
import { applicantSessionCookie } from "./portal-cookie";
import { selectDepartments } from "./recruitment-helpers";

test.setTimeout(180_000);

async function devLogin(page: Page, email: string) {
  await page.goto("/login");
  await page.fill('input[name="email"]', email);
  await page.click('button:has-text("Dev sign in")');
  await page.waitForURL((url) => url.pathname === "/");
}

function identitySection(page: Page) {
  return page
    .locator("section")
    .filter({ has: page.locator("h2").filter({ hasText: "Your information" }) })
    .first();
}

// The whole test run flow as the recruitment team uses it: copy a real cycle,
// change the real form afterwards and see the test run pick it up, apply to the
// test run as a fake person, check that person never reaches the real cycle,
// then delete the test run.
test("recruitment test run: follows the real cycle, takes fake applicants, deletes cleanly", async ({
  page,
  context,
}) => {
  await devLogin(page, "j.carney@yale.edu");

  // Real cycle (left as a draft the whole time)
  const realSlug = `test-run-e2e-${Date.now()}`;
  await page.goto("/recruitment/cycles/new");
  await page.fill('input[name="title"]', "Test Run E2E");
  await page.fill('input[name="publicSlug"]', realSlug);
  await selectDepartments(page, ["SRHD"]);
  await page.uncheck('input[name="seedDefaultForm"]');
  await page.click('button:has-text("Create")');
  await page.waitForURL((url) => url.pathname.includes("/builder"));
  const realId = page.url().split("/cycles/")[1].split("/")[0];

  // Start a test run from the real cycle's overview
  await page.goto(`/recruitment/cycles/${realId}`);
  await page.getByRole("button", { name: "Start a test run" }).click();
  await page.waitForURL((url) => url.searchParams.has("testcreated"));
  const testId = page.url().split("/cycles/")[1].split(/[/?]/)[0];
  expect(testId).not.toBe(realId);
  await expect(page.getByText(/^Test run of/).first()).toBeVisible();

  // Change the real form after the copy was made
  await page.goto(`/recruitment/cycles/${realId}/builder`);
  await identitySection(page).getByRole("button", { name: /Add field/ }).click();
  await page.getByRole("button", { name: "Paragraph", exact: true }).click();
  await expect(identitySection(page).getByText("Paragraph", { exact: true })).toBeVisible();

  // The test run already has it, with no re-copy
  await page.goto(`/recruitment/cycles/${testId}/builder`);
  await expect(page.getByText(/^Test run of/).first()).toBeVisible();
  await expect(identitySection(page).getByText("Paragraph", { exact: true })).toBeVisible();

  // Publish only the test run and read its own link
  await page.goto(`/recruitment/cycles/${testId}`);
  await page.click('button:has-text("Publish")');
  await expect(page.locator("span").filter({ hasText: /^Open$/ })).toBeVisible();
  const testSlug = (await page.content()).match(new RegExp(`/apply/(${realSlug}-test-[0-9a-f]+)`))?.[1];
  expect(testSlug).toBeTruthy();

  // Apply to the test run as a fake person
  const applicantEmail = `e2e-test-run-${Date.now()}@yale.edu`;
  const ctx = await context.browser()!.newContext();
  await ctx.addCookies([applicantSessionCookie(applicantEmail)]);
  const apply = await ctx.newPage();
  await apply.goto(`/apply/${testSlug}`);
  const submit = apply.getByRole("button", { name: "Submit application" });
  const continueBtn = apply.getByRole("button", { name: "Continue" });
  const firstName = apply.locator('input[name="first_name"]');
  for (let i = 0; i < 8; i++) {
    await expect(continueBtn.or(submit)).toBeVisible({ timeout: 45_000 });
    if (await submit.isVisible().catch(() => false)) break;
    if (await firstName.isVisible().catch(() => false)) {
      await firstName.fill("Fiona");
      await apply.fill('input[name="last_name"]', "Fake");
      await apply.fill('input[name="email"]', applicantEmail);
    }
    await continueBtn.click();
  }
  await submit.click();
  await expect(apply.getByText(/your application was received/i)).toBeVisible();
  await ctx.close();

  // The fake applicant is in the test run and nowhere in the real cycle
  await page.goto(`/recruitment/cycles/${testId}/applicants`);
  await expect(page.getByRole("link", { name: /Fiona/ })).toBeVisible();
  await page.goto(`/recruitment/cycles/${realId}/applicants`);
  await expect(page.getByRole("link", { name: /Fiona/ })).toHaveCount(0);

  // The real cycle is untouched: still a draft
  await page.goto(`/recruitment/cycles/${realId}`);
  await expect(page.locator("span").filter({ hasText: /^Draft$/ }).first()).toBeVisible();

  // Delete the test run; it lands back on the real cycle and is gone from its list
  await page.goto(`/recruitment/cycles/${testId}`);
  await page.getByRole("button", { name: "Delete test run" }).click();
  await page.getByRole("button", { name: "Delete this test run and everyone in it?" }).click();
  await page.waitForURL((url) => url.pathname === `/recruitment/cycles/${realId}`);
  await expect(page.getByRole("link", { name: "[TEST] Test Run E2E" })).toHaveCount(0);
});
