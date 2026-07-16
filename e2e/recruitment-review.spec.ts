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
  await selectDepartments(page, ["SRHD", "MDIC"]);
  // Build the form ourselves (minimal name+email seed) so the apply wizard stays
  // a simple identity-only flow; the default form has required files + subcommittees.
  await page.uncheck('input[name="seedDefaultForm"]');
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
  // The application is a multi-step wizard: fill the identity section while it is the
  // visible step, advance with Continue, and Submit only on the final Review step.
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
      await firstNameField.fill("Onee");
      await apply.fill('input[name="last_name"]', "X");
      await apply.fill('input[name="email"]', applicantEmail);
    }
    await continueBtn.click();
  }
  await expect(submit).toBeVisible();
  await submit.click();
  await expect(apply.getByText(/your application was received/i)).toBeVisible();
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
