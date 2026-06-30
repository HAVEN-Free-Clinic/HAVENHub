import { expect, test } from "@playwright/test";
import { applicantSessionCookie } from "./portal-cookie";

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
  await page.fill('input[name="departments"]', "EDUC, PCAR");
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
  await apply.fill('input[name="first_name"]', "Dee");
  await apply.fill('input[name="last_name"]', "Rector");
  await apply.fill('input[name="email"]', applicantEmail);
  await apply.click('button:has-text("Submit application")');
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
  await page.click('button:has-text("Release decisions")');

  await page.waitForURL((url) =>
    url.pathname.includes("/decisions") && url.searchParams.has("sent")
  );
  await expect(page.getByText(/Released 1 acceptance email\(s\)/)).toBeVisible();
});
