import { expect, test } from "@playwright/test";
import { applicantSessionCookie } from "./portal-cookie";

test.setTimeout(120_000);

async function devLogin(page: import("@playwright/test").Page, email: string) {
  await page.goto("/login");
  await page.fill('input[name="email"]', email);
  await page.click('button:has-text("Dev sign in")');
  await page.waitForURL((url) => url.pathname === "/");
}

// NOTE: the public /onboard/[token] submit + bulk promote are covered by integration
// tests (onboarding.test.ts, promotion.test.ts). This e2e verifies the admin flow:
// accept -> send onboarding link -> status "Sent".
//
// Modernized: the application is submitted through the portal as a verified
// applicant (forged applicant_session cookie; see portal-cookie). The admin picks
// the department at accept time (the applicant's own department choice is not
// required for an admin reviewer), so the builder DEPARTMENT_CHOICE step was dropped.
test("onboarding: accept then send onboarding link", async ({ page, context }) => {
  await devLogin(page, "j.carney@yale.edu");

  // --- Build + publish a single-department volunteer cycle ---
  await page.goto("/recruitment/cycles/new");
  await page.fill('input[name="title"]', "Onboard E2E");
  const slug = `onboard-e2e-${Date.now()}`;
  await page.fill('input[name="publicSlug"]', slug);
  await page.fill('input[name="departments"]', "SRHD");
  await page.click('button:has-text("Create")');
  await page.waitForURL((url) => url.pathname.includes("/builder"));
  const cycleId = page.url().split("/cycles/")[1].split("/")[0];

  await page.goto(`/recruitment/cycles/${cycleId}`);
  await page.click('button:has-text("Publish")');
  await expect(page.locator("span").filter({ hasText: "OPEN" })).toBeVisible();

  // --- Submit a public application as a verified portal applicant ---
  const applicantEmail = `e2e-ona-${Date.now()}@yale.edu`;
  const ctx = await context.browser()!.newContext();
  await ctx.addCookies([applicantSessionCookie(applicantEmail)]);
  const apply = await ctx.newPage();
  await apply.goto(`/apply/${slug}`);
  await apply.fill('input[name="first_name"]', "Ona");
  await apply.fill('input[name="last_name"]', "Boarder");
  await apply.fill('input[name="email"]', applicantEmail);
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
