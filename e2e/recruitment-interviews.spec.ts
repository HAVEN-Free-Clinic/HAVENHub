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

// Modernized: the director applicant applies through the portal as a verified
// identity (forged applicant_session cookie; see portal-cookie). An admin reviewer
// sees all cycle departments at schedule time, so the builder DEPARTMENT_CHOICE
// step was dropped.
test("director interview: schedule, decide accept, release", async ({
  page,
  context,
}) => {
  await devLogin(page, "j.carney@yale.edu");

  // --- Create + publish a DIRECTOR cycle ---
  await page.goto("/recruitment/cycles/new");
  await page.fill('input[name="title"]', "Director E2E");
  const slug = `dir-e2e-${Date.now()}`;
  await page.fill('input[name="publicSlug"]', slug);
  await page.selectOption('select[name="track"]', "DIRECTOR");
  await selectDepartments(page, ["EDUC", "PCAR"]);
  // Build the form ourselves (minimal name+email seed) so the apply wizard stays
  // a simple identity-only flow; the default form has required files + subcommittees.
  await page.uncheck('input[name="seedDefaultForm"]');
  await page.click('button:has-text("Create")');
  await page.waitForURL((url) => url.pathname.includes("/builder"));
  const cycleId = page.url().split("/cycles/")[1].split("/")[0];

  await page.goto(`/recruitment/cycles/${cycleId}`);
  await page.click('button:has-text("Publish")');
  await expect(page.locator("span").filter({ hasText: "OPEN" })).toBeVisible();

  // --- Submit a public application as a verified portal applicant ---
  const applicantEmail = `e2e-dee-${Date.now()}@yale.edu`;
  const pub = await context.browser()!.newContext();
  await pub.addCookies([applicantSessionCookie(applicantEmail)]);
  const apply = await pub.newPage();
  await apply.goto(`/apply/${slug}`);
  // The application is a multi-step wizard: fill the identity section while it is the
  // visible step, advance with Continue, and Submit only on the final Review step.
  const submit = apply.getByRole("button", { name: "Submit application" });
  const firstNameField = apply.locator('input[name="first_name"]');
  for (let i = 0; i < 8; i++) {
    if (await submit.isVisible().catch(() => false)) break;
    if (await firstNameField.isVisible().catch(() => false)) {
      await firstNameField.fill("Dee");
      await apply.fill('input[name="last_name"]', "Rector");
      await apply.fill('input[name="email"]', applicantEmail);
    }
    await apply.getByRole("button", { name: "Continue" }).click();
  }
  await expect(submit).toBeVisible();
  await submit.click();
  await expect(apply.getByText(/your application was received/i)).toBeVisible();
  await pub.close();

  // --- Navigate to the applicant and schedule an interview ---
  await page.goto(`/recruitment/cycles/${cycleId}/applicants`);
  await page.getByRole("link", { name: /Dee Rector/ }).click();
  await page.waitForURL((url) => url.pathname.includes("/applicants/"));

  // Director branch: select department and click "Schedule interview"
  await page.locator('select[name="departmentCode"]').selectOption("EDUC");
  await page.click('button:has-text("Schedule interview")');
  // scheduleInterviewAction redirects to the interview detail page
  await page.waitForURL((url) => url.pathname.includes("/interviews/"));

  // --- Set interview time and save ---
  await page.fill('input[name="scheduledAt"]', "2026-04-15T18:30");
  await page.click('button:has-text("Save")');

  // --- Record ACCEPT decision ---
  await page.locator('select[name="outcome"]').selectOption("ACCEPT");
  await page.click('button:has-text("Record decision")');

  // decideAction revalidates in place (no redirect); wait for the page to settle
  await page.waitForLoadState("networkidle");

  // --- Decisions page: release and assert acceptance email queued ---
  await page.goto(`/recruitment/cycles/${cycleId}/decisions`);
  // "Release decisions" is now a two-click ConfirmButton (arms, then confirms).
  await page.click('button:has-text("Release decisions")');
  await page.click('button:has-text("Send acceptance emails?")');

  await page.waitForURL((url) =>
    url.pathname.includes("/decisions") && url.searchParams.has("sent")
  );
  await expect(page.getByText(/Released 1 acceptance email\(s\)/)).toBeVisible();
});
