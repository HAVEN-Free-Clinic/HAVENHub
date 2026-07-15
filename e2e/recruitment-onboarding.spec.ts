import { expect, test } from "@playwright/test";
import { applicantSessionCookie } from "./portal-cookie";
import { fillDefaultApplication } from "./fixtures";

test.setTimeout(120_000);

async function devLogin(page: import("@playwright/test").Page, email: string) {
  await page.goto("/login");
  await page.fill('input[name="email"]', email);
  await page.click('button:has-text("Dev sign in")');
  await page.waitForURL((url) => url.pathname === "/");
}

// Volunteer applicants are NOT interviewed: the routed department decides
// directly from the committee score. Acceptance now happens through: route the
// applicant to a department (Routing card, visible because scope.all &&
// cycle.track === "VOLUNTEER") -> record an ACCEPT on the Department decision
// card (decideRoutedAction -> decideRoutedApplication), which mints the Acceptance.
async function acceptViaDecision(
  page: import("@playwright/test").Page,
  cycleId: string,
  applicantLinkName: RegExp,
  dept: string,
) {
  await page.goto(`/recruitment/cycles/${cycleId}/applicants`);
  await page.getByRole("link", { name: applicantLinkName }).click();
  await page.waitForURL((url) => url.pathname.includes("/applicants/"));

  // --- Route (Routing card; select[name="departmentCode"] + "Route" button) ---
  await page.locator('select[name="departmentCode"]').selectOption(dept);
  await page.getByRole("button", { name: "Route" }).click();

  // --- Record ACCEPT directly (Department decision card, appears once routed) ---
  await page.locator('select[name="outcome"]').selectOption("ACCEPT");
  await page.getByRole("button", { name: "Record decision" }).click();
  await expect(page.getByText("Decision recorded.")).toBeVisible();
}

// NOTE: the public /onboard/[token] submit + bulk promote are covered by integration
// tests (onboarding.test.ts, promotion.test.ts). This e2e verifies the admin flow:
// route -> record ACCEPT decision -> send onboarding link -> status "Sent".
//
// The application is submitted through the portal as a verified applicant (forged
// applicant_session cookie; see portal-cookie). The admin routes the department at
// decision time, so the builder DEPARTMENT_CHOICE step was dropped.
test("onboarding: accept via department decision, then send onboarding link", async ({ page, context }) => {
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
  // Walk the default VOLUNTEER wizard end to end and submit. SRHD is the
  // cycle's only department and carries no VOLUNTEER department supplement.
  await fillDefaultApplication(apply, { email: applicantEmail, department: "SRHD", firstName: "Ona", lastName: "Boarder" });
  await ctx.close();

  // --- Accept the applicant into SRHD via route -> record ACCEPT (no interview) ---
  await acceptViaDecision(page, cycleId, /Ona Boarder/, "SRHD");

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
