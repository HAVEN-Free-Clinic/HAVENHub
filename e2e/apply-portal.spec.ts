import { expect, test } from "@playwright/test";
import { applicantSessionCookie } from "./portal-cookie";
import { selectDepartments } from "./recruitment-helpers";

// The public application portal overrides the hub's browser-tab title with the
// configurable branding.applyPortalTitle setting (default "HAVEN Application
// Portal"), so the portal - and the apply subdomain that serves it - does not
// read "HAVEN Hub". No auth or cycle fixture is needed: the title comes from the
// apply/layout.tsx metadata, which is the same for signed-in and signed-out
// visitors. Regression for the portal inheriting the hub title.
test("apply portal: tab title uses the configurable portal title", async ({ page }) => {
  await page.goto("/apply");
  await expect(page).toHaveTitle(/HAVEN Application Portal/);
});

test.setTimeout(120_000);

async function devLogin(page: import("@playwright/test").Page, email: string) {
  await page.goto("/login");
  await page.fill('input[name="email"]', email);
  await page.click('button:has-text("Dev sign in")');
  await page.waitForURL((url) => url.pathname === "/");
}

test("apply portal: an applicant can withdraw a submitted application", async ({ page, context }) => {
  await devLogin(page, "j.carney@yale.edu");

  // --- Build and publish a volunteer cycle ---
  await page.goto("/recruitment/cycles/new");
  await page.fill('input[name="title"]', "Withdraw E2E");
  const slug = `withdraw-e2e-${Date.now()}`;
  await page.fill('input[name="publicSlug"]', slug);
  await selectDepartments(page, ["SRHD"]);
  // Minimal identity-only form: the default form has required files and
  // subcommittee ranking, which the wizard loop below does not fill.
  await page.uncheck('input[name="seedDefaultForm"]');
  await page.click('button:has-text("Create")');
  await page.waitForURL((url) => url.pathname.includes("/builder"));
  const cycleId = page.url().split("/cycles/")[1].split("/")[0];

  await page.goto(`/recruitment/cycles/${cycleId}`);
  await page.click('button:has-text("Publish")');
  // Anchor the badge match: a bare "OPEN" substring also matches "Opens".
  await expect(page.locator("span").filter({ hasText: /^OPEN$/ })).toBeVisible();

  // --- Submit as a verified portal applicant ---
  const applicantEmail = `e2e-withdraw-${Date.now()}@yale.edu`;
  const ctx = await context.browser()!.newContext();
  await ctx.addCookies([applicantSessionCookie(applicantEmail)]);
  const apply = await ctx.newPage();
  await apply.goto(`/apply/${slug}`);

  const submit = apply.getByRole("button", { name: "Submit application" });
  const continueBtn = apply.getByRole("button", { name: "Continue" });
  const firstNameField = apply.locator('input[name="first_name"]');
  for (let i = 0; i < 8; i++) {
    // Settle on the step before acting: a blind Continue click on the Review
    // step (where the button is already Submit) hangs the whole test.
    await expect(continueBtn.or(submit)).toBeVisible({ timeout: 45_000 });
    if (await submit.isVisible().catch(() => false)) break;
    if (await firstNameField.isVisible().catch(() => false)) {
      await firstNameField.fill("Wanda");
      await apply.fill('input[name="last_name"]', "Withdrawn");
      await apply.fill('input[name="email"]', applicantEmail);
    }
    await continueBtn.click();
  }
  await expect(submit).toBeVisible();
  await submit.click();
  await expect(apply.getByText(/your application was received/i)).toBeVisible();

  // --- Positive control: prove the queue-exclusion check below is real. Without
  // this, an unrelated regression (permission redirect, broken query, route
  // rename) could leave the queue empty for the wrong reason and the final
  // toHaveCount(0) assertion would still pass by accident. ---
  await page.goto(`/recruitment/cycles/${cycleId}/applicants`);
  await expect(page.getByRole("link", { name: /Wanda/ })).toBeVisible();

  // --- Withdraw from the portal home ---
  await apply.goto("/apply");
  // Scope to the status badge, not a bare text match: the SUBMITTED state also
  // renders a progress-tracker step literally labeled "Submitted" alongside it,
  // so an unscoped getByText("Submitted") resolves to two elements.
  const statusBadge = apply.locator("span.bg-brand-faint");
  await expect(statusBadge).toHaveText("Submitted");
  const withdrawBtn = apply.getByRole("button", { name: "Withdraw application" });
  await withdrawBtn.click(); // arms the two-click ConfirmButton
  await apply.getByRole("button", { name: /Withdraw\? We will stop considering you/ }).click();

  await expect(statusBadge).toHaveText("Withdrawn");
  await expect(apply.getByRole("button", { name: "Withdraw application" })).toHaveCount(0);

  // --- The form itself is closed to them too. Withdrawal is terminal for the
  // applicant (only staff can reopen), so returning to /apply/<slug> must show a
  // terminal notice, not the wizard prefilled with the answers they withdrew:
  // that path lets them retype the whole form, swallows every autosave, and then
  // fails the submit with "you have already applied". ---
  await apply.goto(`/apply/${slug}`);
  await expect(apply.getByRole("heading", { name: "Application withdrawn" })).toBeVisible();
  await expect(apply.locator('input[name="first_name"]')).toHaveCount(0);
  await ctx.close();

  // --- The applicant is gone from the review queue ---
  await page.goto(`/recruitment/cycles/${cycleId}/applicants`);
  await expect(page.getByRole("link", { name: /Wanda/ })).toHaveCount(0);
});
