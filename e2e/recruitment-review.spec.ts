import { expect, test } from "@playwright/test";
import { applicantSessionCookie } from "./portal-cookie";

test.setTimeout(120_000);

async function devLogin(page: import("@playwright/test").Page, email: string) {
  await page.goto("/login");
  await page.fill('input[name="email"]', email);
  await page.click('button:has-text("Dev sign in")');
  await page.waitForURL((url) => url.pathname === "/");
}

// Modernized: applicants apply through the portal as verified identities (forged
// applicant_session cookie; see portal-cookie). An admin reviewer sees all cycle
// departments at accept time, so the builder DEPARTMENT_CHOICE step was dropped;
// the conflict here is created admin-side by accepting one applicant into two
// departments.
test("review: accept, conflict, release", async ({ page, context }) => {
  await devLogin(page, "j.carney@yale.edu");

  // --- Build + publish a two-department volunteer cycle ---
  await page.goto("/recruitment/cycles/new");
  await page.fill('input[name="title"]', "Review E2E");
  const slug = `review-e2e-${Date.now()}`;
  await page.fill('input[name="publicSlug"]', slug);
  await page.fill('input[name="departments"]', "SRHD, MDIC");
  await page.click('button:has-text("Create")');
  await page.waitForURL((url) => url.pathname.includes("/builder"));
  const cycleId = page.url().split("/cycles/")[1].split("/")[0];

  await page.goto(`/recruitment/cycles/${cycleId}`);
  await page.click('button:has-text("Publish")');
  await expect(page.locator("span").filter({ hasText: "OPEN" })).toBeVisible();

  // --- Submit two public applications as verified portal applicants ---
  for (const first of ["Onee", "Twoo"] as const) {
    const applicantEmail = `e2e-${first.toLowerCase()}-${Date.now()}@yale.edu`;
    const ctx = await context.browser()!.newContext();
    await ctx.addCookies([applicantSessionCookie(applicantEmail)]);
    const apply = await ctx.newPage();
    await apply.goto(`/apply/${slug}`);
    await apply.fill('input[name="first_name"]', first);
    await apply.fill('input[name="last_name"]', "X");
    await apply.fill('input[name="email"]', applicantEmail);
    await apply.click('button:has-text("Submit application")');
    await expect(apply.getByText(/your application was received/i)).toBeVisible();
    await ctx.close();
  }

  // --- Accept Onee into SRHD ---
  await page.goto(`/recruitment/cycles/${cycleId}/applicants`);
  await page.getByRole("link", { name: /Onee/ }).click();
  await page.waitForURL((url) => url.pathname.includes("/applicants/"));
  await page.locator('select[name="departmentCode"]').selectOption("SRHD");
  await page.click('button:has-text("Accept")');
  await expect(page.getByText(/Accepted into/)).toBeVisible();
  await expect(page.locator("strong", { hasText: "SRHD" })).toBeVisible();

  // --- Accept Twoo into SRHD, then MDIC (creating a conflict) ---
  await page.goto(`/recruitment/cycles/${cycleId}/applicants`);
  await page.getByRole("link", { name: /Twoo/ }).click();
  await page.waitForURL((url) => url.pathname.includes("/applicants/"));

  await page.locator('select[name="departmentCode"]').selectOption("SRHD");
  await page.click('button:has-text("Accept")');
  await expect(page.getByText(/Accepted into/)).toBeVisible();
  await expect(page.locator("strong", { hasText: "SRHD" })).toBeVisible();

  // Second acceptance: MDIC (the select now only shows remaining departments)
  await page.locator('select[name="departmentCode"]').selectOption("MDIC");
  await page.click('button:has-text("Accept")');
  await expect(page.locator("strong", { hasText: "MDIC" })).toBeVisible();

  // --- Decisions page: conflict shown, release reports 1 sent / 1 skipped ---
  await page.goto(`/recruitment/cycles/${cycleId}/decisions`);

  // Conflict row shows "{name} accepted by SRHD + MDIC" (order may vary)
  await expect(page.getByText(/SRHD \+ MDIC|MDIC \+ SRHD/)).toBeVisible();

  await page.click('button:has-text("Release decisions")');

  // The action redirects back with ?sent=N&skipped=M query params; wait for the banner
  await page.waitForURL((url) =>
    url.pathname.includes("/decisions") && url.searchParams.has("sent")
  );
  await expect(
    page.getByText(/Released 1 acceptance email\(s\); skipped 1 conflicted applicant\(s\)\./)
  ).toBeVisible();
});
