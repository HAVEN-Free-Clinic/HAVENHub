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
// card (decideRoutedAction -> decideRoutedApplication), which transactionally
// mints the Acceptance.
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

// Applicants apply through the portal as verified identities (forged
// applicant_session cookie; see portal-cookie). Routing assigns exactly one
// department per applicant and a volunteer holds at most one Acceptance, so the
// old multi-department conflict scenario is unreachable; this verifies the
// clean, no-conflict release path.
test("review: accept via department decision, release with no conflicts", async ({ page, context }) => {
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

  // --- Submit one public application as a verified portal applicant ---
  const applicantEmail = `e2e-onee-${Date.now()}@yale.edu`;
  const ctx = await context.browser()!.newContext();
  await ctx.addCookies([applicantSessionCookie(applicantEmail)]);
  const apply = await ctx.newPage();
  await apply.goto(`/apply/${slug}`);
  // Walk the default VOLUNTEER wizard end to end and submit. SRHD (the same
  // department Onee is routed into below) carries no VOLUNTEER department
  // supplement, so this stays on the shared default-template steps.
  await fillDefaultApplication(apply, { email: applicantEmail, department: "SRHD", firstName: "Onee", lastName: "X" });
  await ctx.close();

  // --- Accept Onee into SRHD via route -> record ACCEPT (no interview) ---
  await acceptViaDecision(page, cycleId, /Onee/, "SRHD");

  // --- Decisions page: release, assert the no-conflict banner ---
  await page.goto(`/recruitment/cycles/${cycleId}/decisions`);

  // "Release decisions" is a two-click ConfirmButton (arms, then confirms).
  await page.click('button:has-text("Release decisions")');
  await page.click('button:has-text("Send acceptance emails?")');

  // The action redirects back with ?sent=N&skipped=M query params; wait for the banner.
  await page.waitForURL((url) =>
    url.pathname.includes("/decisions") && url.searchParams.has("sent")
  );
  // With a single routed applicant there is no possible conflict, so skipped is 0.
  await expect(
    page.getByText(/Released 1 acceptance email\(s\); skipped 0 conflicted applicant\(s\)\./)
  ).toBeVisible();
});
