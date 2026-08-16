import { expect, test } from "@playwright/test";
import { devLogin } from "./auth";
import { tag } from "./fixtures";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A person to link as a report subject via the Section 4 picker: the option
 * text used to find them in the combobox, and whether to request a strike
 * against them (only meaningful -- and only rendered -- for a volunteer the
 * actor manages).
 */
type ReportSubject = { optionText: string; requestStrike?: boolean };

/**
 * Files a "Report a concern" form: checks the first concern type, fills the
 * description, adds each of `subjects` via the Section 4 picker, then
 * submits.
 *
 * The picker adds people one at a time: select a combobox option, then click
 * "Add" to append them to an on-page list. Each added person renders as an
 * <li> with their name, a "Remove" button, and, only for a volunteer the
 * actor manages, a "Request a strike" checkbox named `strikePersonIds`
 * (valued with their person id). A strike is requested by checking that
 * checkbox scoped to the just-added person's <li>, so requesting one
 * person's strike never touches another's row.
 *
 * Labels on /incidents are plain <label> elements wrapping their control (no
 * htmlFor/id association usable with getByLabel for the checkbox rows), so
 * this mirrors the rest of the suite's convention of driving forms by
 * name/placeholder selectors instead.
 *
 * Returns the submitted report's number, parsed off the
 * /incidents/mine?submitted=<number> redirect.
 */
async function submitReport(
  page: import("@playwright/test").Page,
  description: string,
  subjects: ReportSubject[] = []
): Promise<string> {
  await page.goto("/incidents");
  await page.waitForURL((url) => url.pathname === "/incidents");

  // Section 1: at least one concern type.
  await page.locator('input[name="concernTypes"]').first().check();

  // Section 2: description (required).
  await page.locator('textarea[name="description"]').fill(description);

  // Section 6: ongoing risk (required, no default -- see page.tsx). None of
  // these flows exercise the immediate-risk flag itself, so answer "No" here
  // to keep prior behavior; a dedicated assertion for the "Yes" path and for
  // the native required-blocks-submit behavior lives outside this suite (see
  // page.tsx's comment on Section 6).
  await page.locator('input[name="immediateRisk"][value="no"]').check();

  // Section 4: link each subject via the searchable combobox, then click
  // "Add" to append them to the on-page list. Adding a person remounts the
  // combobox (clearing its text), so each loop iteration starts from the
  // same clean state as the last.
  for (const subject of subjects) {
    const subjectInput = page.getByRole("combobox", { name: "Link the people involved (optional)" });
    await subjectInput.click();
    await subjectInput.fill(subject.optionText);
    await page.getByRole("option").filter({ hasText: subject.optionText }).first().click();
    await page.getByRole("button", { name: "Add" }).click();

    if (subject.requestStrike) {
      // Only rendered for a volunteer the actor manages; scope to this
      // person's <li> so checking one person's box never checks another's.
      const row = page.locator("li").filter({ hasText: subject.optionText });
      await row.locator('input[name="strikePersonIds"]').check();
    }
  }

  await page.getByRole("button", { name: "Submit report" }).click();

  // submitReportAction redirects to /incidents/mine?submitted=<number>, but the toast
  // reader consumes that param and strips it with router.replace, so waiting on the
  // param being present is a race the test loses. Wait on the destination, then read
  // the number out of the toast, which renders "Report #<number> submitted."
  await page.waitForURL((url) => url.pathname === "/incidents/mine");
  const toast = page.getByText(/^Report #\d+ submitted\.$/);
  await expect(toast).toBeVisible();
  const number = ((await toast.textContent()) ?? "").match(/#(\d+)/)?.[1];
  if (!number) throw new Error("submitReportAction did not report a submitted report number");
  return number;
}

/**
 * Click a ConfirmButton (two-click protocol) scoped to a container locator.
 * First click arms it; second click submits. Duplicated from
 * volunteers.spec.ts (not exported there) for the strikes-ledger cleanup in
 * Test C below.
 */
async function confirmButtonClick(
  container: import("@playwright/test").Locator,
  label: string
) {
  await container.getByRole("button", { name: label, exact: true }).click();
  await container.getByRole("button").filter({ hasText: /\?/ }).first().click();
}

// ---------------------------------------------------------------------------
// Test A: anyone can file a report
// ---------------------------------------------------------------------------

/**
 * dev.volunteer holds no incidents.manage / issuable directorships, so this
 * exercises the plain "report about anyone" path with no subject picker and
 * no strike request. No residue cleanup: IncidentReport has no delete route
 * (append-only, like an audit record), matching the epic test's precedent
 * for un-deletable rows left in the dev DB.
 */
test("anyone can file a report: dev.volunteer submits one and sees it in My reports", async ({ page }) => {
  await devLogin(page, "dev.volunteer@yale.edu");

  const description = `E2E incident ${tag()}`;
  // submitReport already asserts the confirmation toast and reads the number out of it.
  // Do not re-assert it here: it is a success toast, so it auto-dismisses about four
  // seconds after it appeared, and this assertion would be racing that timer.
  const number = await submitReport(page, description);

  // The new report's row is visible, linking to its detail page. exact: true
  // guards against a substring match on another row (e.g. "#7" inside "#71").
  const row = page.locator("tr").filter({ has: page.getByRole("link", { name: `#${number}`, exact: true }) });
  await expect(row).toBeVisible();
});

// ---------------------------------------------------------------------------
// Test B: reviewer round trip
// ---------------------------------------------------------------------------

/**
 * Files its own report as the admin reviewer (simpler and more isolated than
 * depending on Test A's report / execution order) then exercises the
 * reviewer queue and the status form on the detail page.
 */
test("reviewer round trip: admin resolves a report and the status badge updates", async ({ page }) => {
  await devLogin(page, "j.carney@yale.edu");

  const description = `E2E reviewer round trip ${tag()}`;
  const number = await submitReport(page, description);

  // Open the review queue, filtered to this exact report by number (q matches
  // report.number by equality, so this returns exactly one row).
  await page.goto(`/incidents/review?q=${number}`);
  await page.waitForURL((url) => url.pathname === "/incidents/review");
  await expect(page.getByRole("heading", { name: "Review queue" })).toBeVisible();

  // exact: true guards against a substring match on another number (e.g. "#7" inside "#71").
  const reportLink = page.getByRole("link", { name: `#${number}`, exact: true });
  await expect(reportLink).toBeVisible();
  await reportLink.click();
  await page.waitForURL((url) => url.pathname !== "/incidents/review");
  const detailUrl = page.url();

  // Reviewer controls: set status to RESOLVED and save.
  await page.locator('select[name="status"]').selectOption("RESOLVED");
  await page.getByRole("button", { name: "Save status" }).click();

  // reviewReportAction redirects back to the same detail page.
  await page.waitForURL(detailUrl);

  // The status badge next to the "Report #<n>" heading must now read Resolved.
  // Scoped to a <span> (the Badge element) so the <option value="RESOLVED">
  // text inside the status <select> is never a false match.
  const statusBadge = page.locator("span").filter({ hasText: /^Resolved$/ });
  await expect(statusBadge).toBeVisible();
});

// ---------------------------------------------------------------------------
// Test C: strike request -> approve
// ---------------------------------------------------------------------------

/**
 * dev.director (VADM DIRECTOR) already manages dev.volunteer (VADM VOLUNTEER,
 * same active term) via the base dev seed in prisma/seed.ts -- no additional
 * fixture seeding is needed to get a "director manages an active volunteer"
 * relationship for this test. See manageableDepartmentIds /
 * canRequestStrikeAgainst in src/platform/departments.ts and
 * src/modules/incidents/services/report.ts.
 *
 * Cleanup: the resulting DisciplinaryAction (strike) row IS deletable via the
 * strikes ledger, so it is deleted at the end via the same two-click
 * ConfirmButton the (now-removed) disciplinary test used, leaving no
 * DisciplinaryAction residue. The IncidentReport itself has no delete route
 * and is left in place (same documented residue as Tests A/B and the epic
 * test in volunteers.spec.ts).
 */
test("strike request to approve: director requests a strike, admin approves it, it lands on the strikes ledger", async ({
  page,
}) => {
  await devLogin(page, "dev.director@yale.edu");

  const description = `E2E strike request ${tag()}`;
  const number = await submitReport(page, description, [{ optionText: "Dev Volunteer", requestStrike: true }]);

  // My reports shows the aggregate pending-strike label on this report's row.
  // exact: true guards against a substring match on another row (e.g. "#7"
  // inside "#71").
  const myRow = page.locator("tr").filter({ has: page.getByRole("link", { name: `#${number}`, exact: true }) });
  await expect(myRow.getByText("Strike pending")).toBeVisible();

  // Switch to the admin reviewer and open the same report.
  // Clear the director session before switching to admin; an active session cookie makes
  // /login redirect to '/' before the email input renders.
  await page.context().clearCookies();
  await devLogin(page, "j.carney@yale.edu");
  await page.goto(`/incidents/review?q=${number}`);
  await page.waitForURL((url) => url.pathname === "/incidents/review");

  const reportLink = page.getByRole("link", { name: `#${number}`, exact: true });
  await expect(reportLink).toBeVisible();
  await reportLink.click();
  await page.waitForURL((url) => url.pathname !== "/incidents/review");
  const detailUrl = page.url();

  // Approve the strike request with a category.
  const approveForm = page.locator('form:has(input[name="approve"][value="yes"])');
  await approveForm.locator('select[name="category"]').selectOption("Attendance");
  // "Approve strike" is a two-click ConfirmButton (arm, then confirm) because it
  // issues a permanent strike and emails the subject.
  await approveForm.getByRole("button", { name: "Approve strike" }).click();
  await approveForm.getByRole("button", { name: "Confirm strike?" }).click();

  // decideStrikeAction redirects back to the same detail page.
  await page.waitForURL(detailUrl);

  // The report now shows the strike as issued (strikeDecision APPROVED).
  await expect(page.getByText("Strike issued")).toBeVisible();

  // The strike now appears on the strikes ledger, then clean it up.
  await page.goto("/incidents/strikes");
  await page.waitForURL((url) => url.pathname === "/incidents/strikes");
  const strikeRow = page.locator("tr").filter({ hasText: "Dev Volunteer" }).filter({ hasText: description });
  await expect(strikeRow).toBeVisible();

  await confirmButtonClick(strikeRow, "Delete");
  await expect(strikeRow).not.toBeVisible();
});

// ---------------------------------------------------------------------------
// Test D: multi-person report, per-person strike
// ---------------------------------------------------------------------------

/**
 * Exercises linking MULTIPLE people to one report and requesting a strike
 * against only one of them. dev.director links "Dev Volunteer" (a managed
 * volunteer, strike requested) and themselves, "Dev Director" (strike not
 * requested), as subjects. The second subject cannot be the admin reviewer
 * (Jack Carney): a report that links the reviewer as a subject is hidden from
 * that reviewer's own queue by the self-adjudication guard, so with only three
 * people in the base dev seed (see prisma/seed.ts) the second subject is
 * dev.director themselves. dev.director is not a volunteer in a department they
 * manage (issuablePeople excludes the actor), so canRequestStrikeAgainst
 * rejects a strike against them and the picker never offers the checkbox for
 * their row -- exercising the "no strike for this subject" path structurally,
 * not just by omission.
 *
 * Cleanup: same as Test C -- the single resulting DisciplinaryAction is
 * deleted via the strikes ledger's two-click ConfirmButton; the IncidentReport
 * itself has no delete route and is left in place.
 */
test("multi-person report: director links two people, admin approves the single requested strike", async ({
  page,
}) => {
  await devLogin(page, "dev.director@yale.edu");

  const description = `E2E multi-person report ${tag()}`;
  const number = await submitReport(page, description, [
    { optionText: "Dev Volunteer", requestStrike: true },
    { optionText: "Dev Director" },
  ]);

  // Switch to the admin reviewer and open the same report.
  // Clear the director session before switching to admin; an active session cookie makes
  // /login redirect to '/' before the email input renders.
  await page.context().clearCookies();
  await devLogin(page, "j.carney@yale.edu");
  await page.goto(`/incidents/review?q=${number}`);
  await page.waitForURL((url) => url.pathname === "/incidents/review");

  const reportLink = page.getByRole("link", { name: `#${number}`, exact: true });
  await expect(reportLink).toBeVisible();
  await reportLink.click();
  await page.waitForURL((url) => url.pathname !== "/incidents/review");
  const detailUrl = page.url();

  // Both linked people appear in the "Individual(s) of concern" section. The
  // subjects list is the only <ul> nested in a <dl> on this page.
  const subjectsList = page.locator("dl ul");
  await expect(subjectsList.getByText("Dev Volunteer")).toBeVisible();
  await expect(subjectsList.getByText("Dev Director")).toBeVisible();

  // Only Dev Volunteer requested a strike, so there is exactly one
  // Approve/Decline form pair on the page. Approve it with a category.
  const approveForm = page.locator('form:has(input[name="approve"][value="yes"])');
  await approveForm.locator('select[name="category"]').selectOption("Attendance");
  // "Approve strike" is a two-click ConfirmButton (arm, then confirm) because it
  // issues a permanent strike and emails the subject.
  await approveForm.getByRole("button", { name: "Approve strike" }).click();
  await approveForm.getByRole("button", { name: "Confirm strike?" }).click();

  // decideStrikeAction redirects back to the same detail page.
  await page.waitForURL(detailUrl);

  // The report now shows the strike as issued for the managed volunteer
  // (strikeDecision APPROVED).
  await expect(page.getByText("Strike issued")).toBeVisible();

  // Exactly one strike lands on the ledger, for Dev Volunteer; Dev Director
  // carries none. Then clean it up.
  //
  // The row is found by the POINTER, not by the report narrative. On a report
  // naming more than one person, decideStrike deliberately gives the strike
  // "See incident report #N..." instead of the narrative, because the ledger is
  // visible to each subject's own directors and the narrative describes everyone
  // on the report -- so copying it onto Dev Volunteer's strike would show Dev
  // Volunteer's directors what was alleged about Dev Director. The single-subject
  // test above still asserts the narrative is carried across, which is where that
  // behaviour is correct.
  const pointer = `See incident report #${number}`;
  await page.goto("/incidents/strikes");
  await page.waitForURL((url) => url.pathname === "/incidents/strikes");
  const strikeRow = page.locator("tr").filter({ hasText: "Dev Volunteer" }).filter({ hasText: pointer });
  await expect(strikeRow).toBeVisible();
  await expect(
    page.locator("tr").filter({ hasText: "Dev Director" }).filter({ hasText: pointer })
  ).toHaveCount(0);
  // The guarantee itself: the multi-person narrative reached the ledger nowhere.
  await expect(page.getByText(description)).toHaveCount(0);

  await confirmButtonClick(strikeRow, "Delete");
  await expect(strikeRow).not.toBeVisible();
});
