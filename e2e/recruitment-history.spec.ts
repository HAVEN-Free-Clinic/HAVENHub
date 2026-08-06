import { expect, test } from "@playwright/test";
import { seedHistoricalApplicant, tag } from "./fixtures";
import { selectDepartments } from "./recruitment-helpers";
import { applicantSessionCookie } from "./portal-cookie";

test.setTimeout(120_000);

async function devSignIn(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', "j.carney@yale.edu");
  await page.click('button:has-text("Dev sign in")');
  await page.waitForURL((url) => url.pathname === "/");
}

test("history browser finds a seeded applicant by email and opens their detail page", async ({ page }) => {
  const t = tag();
  const email = `history-browser-${t}@example.test`;
  const firstName = "E2eHistory";
  const lastName = `Browser ${t}`;
  const fullName = `${firstName} ${lastName}`;
  const { applicant, cleanup } = await seedHistoricalApplicant({ email, firstName, lastName });

  try {
    await devSignIn(page);

    // Search by the seeded email, not by any count of rows: the suite runs
    // serially against a shared, never-emptied database.
    await page.goto("/recruitment/history");
    await page.getByLabel("Search recruitment history").fill(email);
    await page.getByRole("button", { name: "Search" }).click();
    await page.waitForURL((url) => url.pathname === "/recruitment/history" && url.searchParams.get("q") === email);

    // Exact match: a substring match on the name could also hit an unrelated
    // row seeded by an earlier test in this same serial run.
    const resultLink = page.getByRole("link", { name: fullName, exact: true });
    await expect(resultLink).toBeVisible();
    await resultLink.click();

    // Assert the actual destination rather than assuming the click navigated.
    await page.waitForURL((url) => url.pathname === `/recruitment/history/${applicant.id}`);

    await expect(page.getByRole("heading", { name: fullName, level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Known emails" })).toBeVisible();
    // Not exact: the row also carries a "Primary" badge as a sibling of the
    // email text, so no single element's full text equals the email alone.
    // The address is tag-unique, so a substring match carries no ambiguity risk.
    await expect(page.getByText(email)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Timeline" })).toBeVisible();
    // No HistoricalApplication was seeded for this applicant, so the timeline
    // must render the empty-history copy, not a stale or miscounted summary.
    await expect(page.getByText("First application, no earlier record.", { exact: true })).toBeVisible();
  } finally {
    await cleanup();
  }
});

test("the reviewer's application detail page shows a Past applications card for an applicant with a prior cycle", async ({
  page,
  context,
}) => {
  const t = tag();
  // Matches every other spec's portal-apply email (e.g. recruitment-review.spec.ts):
  // a real-looking Yale address, since that is the only combination exercised
  // against the apply wizard elsewhere in this suite.
  const email = `history-reviewer-${t}@yale.edu`;
  const firstName = "E2eHistory";
  const lastName = `Reviewer ${t}`;
  const fullName = `${firstName} ${lastName}`;
  // Deliberately the pair called out in the task brief as confusable with a
  // substring match: "Applied" is a prefix of "Applied - Rejected".
  const cycleLabel = `E2E Historical Cycle ${t}`;
  const { cleanup } = await seedHistoricalApplicant({
    email,
    application: {
      cycleLabel,
      track: "VOLUNTEER",
      departmentChoices: ["SRHD"],
      furthestStage: "APPLIED",
      outcome: "REJECTED",
    },
  });

  try {
    await devSignIn(page);

    // --- Build + publish a one-department volunteer cycle ---
    await page.goto("/recruitment/cycles/new");
    await page.fill('input[name="title"]', `History Reviewer E2E ${t}`);
    const slug = `history-reviewer-e2e-${t}`;
    await page.fill('input[name="publicSlug"]', slug);
    await selectDepartments(page, ["SRHD"]);
    // Build the form ourselves (minimal name+email seed); the default form's
    // required files/subcommittees are irrelevant to this coverage.
    await page.uncheck('input[name="seedDefaultForm"]');
    await page.click('button:has-text("Create")');
    await page.waitForURL((url) => url.pathname.includes("/builder"));
    const cycleId = page.url().split("/cycles/")[1].split("/")[0];

    await page.goto(`/recruitment/cycles/${cycleId}`);
    await page.click('button:has-text("Publish")');
    await expect(page.locator("span").filter({ hasText: /^OPEN$/ })).toBeVisible();

    // --- Submit one public application, as a verified portal applicant, that
    //     shares its email with the seeded historical applicant above ---
    const ctx = await context.browser()!.newContext();
    await ctx.addCookies([applicantSessionCookie(email)]);
    const apply = await ctx.newPage();
    await apply.goto(`/apply/${slug}`);
    const submit = apply.getByRole("button", { name: "Submit application" });
    const continueBtn = apply.getByRole("button", { name: "Continue" });
    const firstNameField = apply.locator('input[name="first_name"]');
    for (let i = 0; i < 8; i++) {
      // Settle on the step before acting: non-review steps show Continue,
      // Review shows Submit. Avoids a blind click on a Continue button that
      // has already been replaced by Submit on the final step.
      await expect(continueBtn.or(submit)).toBeVisible({ timeout: 45_000 });
      if (await submit.isVisible().catch(() => false)) break;
      if (await firstNameField.isVisible().catch(() => false)) {
        await firstNameField.fill(firstName);
        await apply.fill('input[name="last_name"]', lastName);
        await apply.fill('input[name="email"]', email);
      }
      await continueBtn.click();
    }
    await expect(submit).toBeVisible();
    await submit.click();
    await expect(apply.getByText(/your application was received/i)).toBeVisible();
    await ctx.close();

    // --- Open the new application as the reviewer and check the history card ---
    await page.goto(`/recruitment/cycles/${cycleId}/applicants`);
    const applicantLink = page.getByRole("link", { name: fullName, exact: true });
    await expect(applicantLink).toBeVisible();
    await applicantLink.click();
    await page.waitForURL((url) => url.pathname.includes(`/recruitment/cycles/${cycleId}/applicants/`));

    await expect(page.getByRole("heading", { name: "Past applications" })).toBeVisible();
    // The prior cycle's row: label, then stage-outcome badge anchored so
    // "Applied - Rejected" can never match on the bare "Applied" prefix.
    await expect(page.getByText(cycleLabel, { exact: true })).toBeVisible();
    await expect(page.getByText(/^Applied - Rejected$/)).toBeVisible();
    // The summary line is derived straight from the service's own tallies
    // (applicationCount + furthest), so asserting its exact text pins both at
    // once: one prior application, furthest stage Applied, in this cycle.
    await expect(
      page.getByText(`2nd application. Furthest: Applied (${cycleLabel}).`, { exact: true })
    ).toBeVisible();
  } finally {
    await cleanup();
  }
});
