import { expect, test } from "@playwright/test";

test.setTimeout(120_000);

async function devLogin(page: import("@playwright/test").Page, email: string) {
  await page.goto("/login");
  await page.fill('input[name="email"]', email);
  await page.click('button:has-text("Dev sign in")');
  await page.waitForURL((url) => url.pathname === "/");
}

// NOTE: the public /onboard/[token] submit + bulk promote are covered by integration
// tests (onboarding.test.ts, promotion.test.ts). The e2e cannot read the emailed token,
// so it verifies the admin flow end to end: accept -> send onboarding link -> status "Sent".
test("onboarding: accept then send onboarding link", async ({ page, context }) => {
  await devLogin(page, "j.carney@yale.edu");

  // --- Build + publish a volunteer cycle with DEPARTMENT_CHOICE ---
  await page.goto("/recruitment/cycles/new");
  await page.fill('input[name="title"]', "Onboard E2E");
  const slug = `onboard-e2e-${Date.now()}`;
  await page.fill('input[name="publicSlug"]', slug);
  await page.fill('input[name="departments"]', "SRHD");
  await page.click('button:has-text("Create")');
  await page.waitForURL((url) => url.pathname.includes("/builder"));
  const cycleId = page.url().split("/cycles/")[1].split("/")[0];

  // Add DEPARTMENT_CHOICE to the "Your information" section (mirrors recruitment-review.spec.ts)
  const identitySection = page
    .locator("section")
    .filter({ has: page.locator("h2").filter({ hasText: "Your information" }) })
    .first();
  const identityAddForm = identitySection.locator('form:has(select[name="type"])');
  await identityAddForm.locator('input[name="label"]').fill("1st choice department");
  await identityAddForm.locator('select[name="type"]').selectOption("DEPARTMENT_CHOICE");
  await identityAddForm.locator('button:has-text("Add field")').click();
  await expect(
    identitySection.locator("li").filter({ hasText: "1st choice department" })
  ).toBeVisible();

  // Publish the cycle
  await page.goto(`/recruitment/cycles/${cycleId}`);
  await page.click('button:has-text("Publish")');
  await expect(page.locator("span").filter({ hasText: "OPEN" })).toBeVisible();

  // --- Submit a public application (unauthenticated) ---
  const ctx = await context.browser()!.newContext();
  const apply = await ctx.newPage();
  await apply.goto(`/apply/${slug}`);
  await apply.fill('input[name="first_name"]', "Ona");
  await apply.fill('input[name="last_name"]', "Boarder");
  await apply.fill('input[name="email"]', "ona@yale.edu");
  await apply.locator('select[name="1st_choice_department"]').selectOption("SRHD");
  await apply.click('button:has-text("Submit application")');
  await expect(apply.getByText(/your application was received/i)).toBeVisible();
  await ctx.close();

  // --- Accept the applicant into SRHD ---
  await page.goto(`/recruitment/cycles/${cycleId}/applicants`);
  await page.getByRole("link", { name: /Ona Boarder/ }).click();
  await page.waitForURL((url) => url.pathname.includes("/applicants/"));
  await page.locator('select[name="departmentCode"]').selectOption("SRHD");
  await page.click('button:has-text("Accept")');
  await expect(page.getByText(/Accepted into/)).toBeVisible();

  // --- Onboarding page: send link, assert banner + row status ---
  await page.goto(`/recruitment/cycles/${cycleId}/onboarding`);
  // The checkbox is only rendered when no contract exists yet; one row expected.
  await page.locator('input[name="acceptanceId"]').first().check();
  await page.click('button:has-text("Send onboarding links")');
  // Success banner: "Sent 1 onboarding link(s)."
  await expect(page.getByText(/Sent 1 onboarding link\(s\)\./)).toBeVisible();
  // Status column flips to "Sent" (contract.status === "PENDING")
  await expect(page.getByRole("cell", { name: "Sent" })).toBeVisible();
});
