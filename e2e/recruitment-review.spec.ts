import { expect, test } from "@playwright/test";

test.setTimeout(120_000);

async function devLogin(page: import("@playwright/test").Page, email: string) {
  await page.goto("/login");
  await page.fill('input[name="email"]', email);
  await page.click('button:has-text("Dev sign in")');
  await page.waitForURL((url) => url.pathname === "/");
}

test("review: accept, conflict, release", async ({ page, context }) => {
  await devLogin(page, "j.carney@yale.edu");

  // --- Build + publish a volunteer cycle with DEPARTMENT_CHOICE ---
  await page.goto("/recruitment/cycles/new");
  await page.fill('input[name="title"]', "Review E2E");
  const slug = `review-e2e-${Date.now()}`;
  await page.fill('input[name="publicSlug"]', slug);
  await page.fill('input[name="departments"]', "SRHD, MDIC");
  await page.click('button:has-text("Create")');
  await page.waitForURL((url) => url.pathname.includes("/builder"));
  const cycleId = page.url().split("/cycles/")[1].split("/")[0];

  // Add DEPARTMENT_CHOICE to the "Your information" section (mirrors Plan 10 selectors exactly)
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

  // --- Submit two public applications (unauthenticated), both choosing SRHD ---
  for (const [first, email] of [
    ["Onee", "one@yale.edu"],
    ["Twoo", "two@yale.edu"],
  ] as const) {
    const ctx = await context.browser()!.newContext();
    const apply = await ctx.newPage();
    await apply.goto(`/apply/${slug}`);
    await apply.fill('input[name="first_name"]', first);
    await apply.fill('input[name="last_name"]', "X");
    await apply.fill('input[name="email"]', email);
    await apply.locator('select[name="1st_choice_department"]').selectOption("SRHD");
    await apply.click('button:has-text("Submit application")');
    await expect(apply.getByText(/your application was received/i)).toBeVisible();
    await ctx.close();
  }

  // --- Accept Onee into SRHD ---
  await page.goto(`/recruitment/cycles/${cycleId}/applicants`);
  await page.getByRole("link", { name: /Onee/ }).click();
  await page.waitForURL((url) => url.pathname.includes("/applicants/"));

  // Select SRHD and accept
  await page.locator('select[name="departmentCode"]').selectOption("SRHD");
  await page.click('button:has-text("Accept")');
  // Server action redirects back to the same page; wait for "Accepted into" to appear
  await expect(page.getByText(/Accepted into/)).toBeVisible();
  await expect(page.locator("strong", { hasText: "SRHD" })).toBeVisible();

  // --- Accept Twoo into SRHD, then MDIC (creating a conflict) ---
  await page.goto(`/recruitment/cycles/${cycleId}/applicants`);
  await page.getByRole("link", { name: /Twoo/ }).click();
  await page.waitForURL((url) => url.pathname.includes("/applicants/"));

  // First acceptance: SRHD
  await page.locator('select[name="departmentCode"]').selectOption("SRHD");
  await page.click('button:has-text("Accept")');
  // Page re-renders; wait for SRHD acceptance to appear
  await expect(page.getByText(/Accepted into/)).toBeVisible();
  await expect(page.locator("strong", { hasText: "SRHD" })).toBeVisible();

  // Second acceptance: MDIC (the select now only shows remaining departments -- SRHD is gone)
  // Re-locate the select after page re-render
  await page.locator('select[name="departmentCode"]').selectOption("MDIC");
  await page.click('button:has-text("Accept")');
  // Both acceptances should now be visible
  await expect(page.locator("strong", { hasText: "MDIC" })).toBeVisible();

  // --- Decisions page: conflict shown, release reports 1 sent / 1 skipped ---
  await page.goto(`/recruitment/cycles/${cycleId}/decisions`);

  // Conflict row shows "{name} accepted by SRHD + MDIC" (order may vary)
  await expect(page.getByText(/SRHD \+ MDIC|MDIC \+ SRHD/)).toBeVisible();

  // Click "Release decisions" (standard form POST via server action)
  await page.click('button:has-text("Release decisions")');

  // The action redirects back with ?sent=N&skipped=M query params; wait for the banner
  await page.waitForURL((url) =>
    url.pathname.includes("/decisions") &&
    url.searchParams.has("sent")
  );
  await expect(
    page.getByText(/Released 1 acceptance email\(s\); skipped 1 conflicted applicant\(s\)\./)
  ).toBeVisible();
});
