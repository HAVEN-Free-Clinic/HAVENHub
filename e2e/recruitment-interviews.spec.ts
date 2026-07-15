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
  // BVHD and CRAD carry no DIRECTOR department supplement section (see
  // SUPPLEMENT_DEPARTMENTS.DIRECTOR in templates/application/supplements/dept-codes.ts),
  // so the applicant's department choice below stays on the shared default-template steps.
  await page.fill('input[name="departments"]', "BVHD, CRAD");
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
  // Walk the default DIRECTOR wizard end to end (identity, Yale affiliation,
  // Spanish/other-language gates, HAVEN experience, essays, department,
  // availability, subcommittee rank, logistics) and submit.
  await fillDefaultApplication(apply, { email: applicantEmail, department: "BVHD", firstName: "Dee", lastName: "Rector" });
  await pub.close();

  // --- Navigate to the applicant and schedule an interview ---
  await page.goto(`/recruitment/cycles/${cycleId}/applicants`);
  await page.getByRole("link", { name: /Dee Rector/ }).click();
  await page.waitForURL((url) => url.pathname.includes("/applicants/"));

  // Director branch: select department and click "Schedule interview". Uses
  // the same department the applicant chose above (BVHD) -- a scoped (non
  // seeAll) reviewer can only schedule for a department the applicant ranked
  // (createInterview in services/interviews.ts).
  await page.locator('select[name="departmentCode"]').selectOption("BVHD");
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
