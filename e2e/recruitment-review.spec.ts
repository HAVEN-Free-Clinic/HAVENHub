import { expect, test } from "@playwright/test";
import { applicantSessionCookie } from "./portal-cookie";

test.setTimeout(120_000);

async function devLogin(page: import("@playwright/test").Page, email: string) {
  await page.goto("/login");
  await page.fill('input[name="email"]', email);
  await page.click('button:has-text("Dev sign in")');
  await page.waitForURL((url) => url.pathname === "/");
}

// Task 10 removed the volunteer instant-accept "Accept" button on the applicant
// detail page. Acceptance now only happens through: route the applicant to a
// department (Routing card, visible because scope.all && cycle.track ===
// "VOLUNTEER") -> start an interview (Department-review card; scheduleInterviewAction
// posts a hidden departmentCode and redirects to the interview page) -> record an
// ACCEPT decision (Decision card), which transactionally mints the Acceptance the
// same way the director pipeline always has.
async function acceptViaInterview(
  page: import("@playwright/test").Page,
  cycleId: string,
  applicantLinkName: RegExp,
  dept: string,
) {
  await page.goto(`/recruitment/cycles/${cycleId}/applicants`);
  await page.getByRole("link", { name: applicantLinkName }).click();
  await page.waitForURL((url) => url.pathname.includes("/applicants/"));

  // --- Route (Routing card; src/app/(app)/recruitment/cycles/[id]/applicants/[applicationId]/page.tsx:182-196) ---
  await page.locator('select[name="departmentCode"]').selectOption(dept);
  await page.getByRole("button", { name: "Route" }).click();

  // --- Start interview (Department-review card, appears once routed; same file:246-251) ---
  await page.getByRole("button", { name: "Start interview" }).click();
  // scheduleInterviewAction calls createInterview then redirects to the interview page.
  await page.waitForURL((url) => url.pathname.includes("/recruitment/interviews/"));

  // --- Record ACCEPT decision (Decision card; src/app/(app)/recruitment/interviews/[interviewId]/page.tsx:202-218) ---
  await page.locator('select[name="outcome"]').selectOption("ACCEPT");
  await page.getByRole("button", { name: "Record decision" }).click();
  await expect(page.getByText("Decision recorded.")).toBeVisible();
}

// Modernized: applicants apply through the portal as verified identities (forged
// applicant_session cookie; see portal-cookie).
//
// Task 10 removed the volunteer instant-accept button and replaced it with a
// route -> interview -> decide pipeline. Routing assigns exactly one department
// per applicant, and createInterview only permits the routed department, so a
// volunteer applicant can hold at most one Acceptance. The multi-department
// conflict scenario this spec used to construct admin-side (accepting one
// applicant into two departments) is therefore no longer reachable; it now
// verifies the clean, no-conflict release path instead.
test("review: accept via interview, release with no conflicts", async ({ page, context }) => {
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
  // The application is a multi-step wizard: fill the identity section while it is the
  // visible step, advance with Continue, and Submit only on the final Review step.
  const submit = apply.getByRole("button", { name: "Submit application" });
  const firstNameField = apply.locator('input[name="first_name"]');
  for (let i = 0; i < 8; i++) {
    if (await submit.isVisible().catch(() => false)) break;
    if (await firstNameField.isVisible().catch(() => false)) {
      await firstNameField.fill("Onee");
      await apply.fill('input[name="last_name"]', "X");
      await apply.fill('input[name="email"]', applicantEmail);
    }
    await apply.getByRole("button", { name: "Continue" }).click();
  }
  await expect(submit).toBeVisible();
  await submit.click();
  await expect(apply.getByText(/your application was received/i)).toBeVisible();
  await ctx.close();

  // --- Accept Onee into SRHD via route -> interview -> record ACCEPT ---
  await acceptViaInterview(page, cycleId, /Onee/, "SRHD");

  // --- Decisions page: release, assert the no-conflict banner ---
  await page.goto(`/recruitment/cycles/${cycleId}/decisions`);

  // "Release decisions" is a two-click ConfirmButton (arms, then confirms).
  await page.click('button:has-text("Release decisions")');
  await page.click('button:has-text("Send acceptance emails?")');

  // The action redirects back with ?sent=N&skipped=M query params; wait for the banner.
  await page.waitForURL((url) =>
    url.pathname.includes("/decisions") && url.searchParams.has("sent")
  );
  // src/app/(app)/recruitment/cycles/[id]/decisions/page.tsx:36-40 renders:
  // `Released ${sent} acceptance email(s); skipped ${skipped} conflicted applicant(s).`
  // With a single routed applicant there is no possible conflict, so skipped is 0.
  await expect(
    page.getByText(/Released 1 acceptance email\(s\); skipped 0 conflicted applicant\(s\)\./)
  ).toBeVisible();
});
