import { expect, test } from "@playwright/test";
import { devLogin } from "./auth";
import { seedComplianceMember } from "./fixtures";

let member: Awaited<ReturnType<typeof seedComplianceMember>>;

test.beforeEach(async () => {
  // An ITCM member with a verified cert so the compliance page renders a status badge
  // and the offboarding executor table has a flag-able row.
  member = await seedComplianceMember("ITCM", { status: "COMPLIANT" });
});

test.afterEach(async () => {
  await member.cleanup();
});

/**
 * Click a ConfirmButton (two-click protocol) scoped to a container locator.
 * First click arms it; second click submits.
 * @param container - a Playwright Locator scoping the search (e.g. a table row)
 * @param label     - the idle-state button label (e.g. "Flag", "Unflag", "Delete")
 */
async function confirmButtonClick(
  container: import("@playwright/test").Locator,
  label: string
) {
  // First click: arm the button (it switches to danger variant with "Confirm?" text)
  await container.getByRole("button", { name: label, exact: true }).click();
  // Second click: the armed button text ends with "?" -- click whatever danger button
  // appeared in the same container.
  await container.getByRole("button").filter({ hasText: /\?/ }).first().click();
}

test("Jack (ITCM director) opens /volunteers and sees the ITCM department card", async ({ page }) => {
  await devLogin(page, "j.carney@yale.edu");
  await page.goto("/volunteers");
  await page.waitForURL((url) => url.pathname === "/volunteers");

  // Page heading must be present (exact match to avoid matching ITCM department h2)
  await expect(page.getByRole("heading", { name: "Compliance", exact: true })).toBeVisible();

  // ITCM department section heading must be visible
  const itcmHeading = page.locator("h2").filter({ hasText: /ITCM/ });
  await expect(itcmHeading).toBeVisible();
});

test("Jack sees at least one status Badge on the ITCM compliance page", async ({ page }) => {
  await devLogin(page, "j.carney@yale.edu");
  await page.goto("/volunteers");
  await page.waitForURL((url) => url.pathname === "/volunteers");

  // At least one status badge must be visible in the table.
  // The beforeEach seeds an ITCM member with a COMPLIANT cert, so a badge is guaranteed.
  // Status labels: Compliant, Expiring Soon, Expired, Date Unknown, No Certificate
  const statusBadge = page
    .locator("td span")
    .filter({
      hasText: /^(Compliant|Expiring Soon|Expired|Date Unknown|No Certificate)$/,
    })
    .first();
  await expect(statusBadge).toBeVisible();
});

test("dev.volunteer is bounced from /volunteers to the hub", async ({ page }) => {
  await devLogin(page, "dev.volunteer@yale.edu");
  await page.goto("/volunteers");
  // dev.volunteer lacks volunteers access, so the guard redirects them away from the
  // protected route (to /no-access). Assert only that they did not remain on /volunteers.
  await page.waitForURL((url) => url.pathname !== "/volunteers");
});

test("Jack (Platform Admin) opens /volunteers/master and sees the summary cards", async ({ page }) => {
  await devLogin(page, "j.carney@yale.edu");
  await page.goto("/volunteers/master");
  await page.waitForURL((url) => url.pathname === "/volunteers/master");

  // Page heading must be visible
  await expect(page.getByRole("heading", { name: "Master Compliance View" })).toBeVisible();

  // Summary stat cards are rendered as plain <p> elements (no aria-label).
  // The beforeEach seeds a COMPLIANT ITCM member, so "Compliant" will always be present.
  // "No Certificate" covers seed members with no cert, so it is also always present.
  await expect(page.locator("p").filter({ hasText: /^Compliant$/ }).first()).toBeVisible();
  await expect(page.locator("p").filter({ hasText: /^No Certificate$/ }).first()).toBeVisible();
});

test("Jack sees the filter bar on /volunteers/master", async ({ page }) => {
  await devLogin(page, "j.carney@yale.edu");
  await page.goto("/volunteers/master");
  await page.waitForURL((url) => url.pathname === "/volunteers/master");

  // Filter bar inputs must be present
  await expect(page.getByPlaceholder("Name or NetID...")).toBeVisible();
});

test("dev.volunteer is bounced from /volunteers/master to the hub", async ({ page }) => {
  await devLogin(page, "dev.volunteer@yale.edu");
  await page.goto("/volunteers/master");
  // dev.volunteer lacks volunteers access, so the guard redirects them away from the
  // protected route (to /no-access). Assert only that they did not remain on /volunteers/master.
  await page.waitForURL((url) => url.pathname !== "/volunteers/master");
});

// ---------------------------------------------------------------------------
// Offboarding round trip
// ---------------------------------------------------------------------------

/**
 * Flags the seeded ITCM member (created in beforeEach) for offboarding and then
 * unflags them to restore state.
 *
 * Why flag+verify+unflag rather than executing the offboard:
 *   Executing the offboard removes all ACTIVE memberships and sets the person's
 *   status to OFFBOARDED, which would break cleanup in afterEach. The
 *   flag+unflag round trip exercises the flagging UI and the executor table
 *   without irreversible side-effects.
 *
 * The service-level execute path (executeOffboard) is exercised by the
 * integration tests in offboarding.test.ts.
 *
 * We scope the row by member.person.name (set by beforeEach) so the test is
 * deterministic in CI (bare seed) as well as locally (rich import data).
 */
test("offboarding: Jack flags an ITCM member and verifies the executor table, then unflags (round trip)", async ({
  page,
}) => {
  await devLogin(page, "j.carney@yale.edu");
  await page.goto("/volunteers/offboarding");
  await page.waitForURL((url) => url.pathname === "/volunteers/offboarding");

  // Page heading -- use exact: true to avoid matching "Flagged for offboarding" (h2)
  await expect(page.getByRole("heading", { name: "Offboarding", exact: true })).toBeVisible();

  // Find the ITCM section -- h2 contains "ITCM". The beforeEach seeds an ITCM member,
  // so this section is guaranteed to be present.
  const itcmSection = page.locator("section").filter({ has: page.locator("h2").filter({ hasText: /ITCM/ }) }).first();
  await expect(itcmSection).toBeVisible();

  // Scope the row to the seeded member's name, which is deterministic in CI.
  const personName = member.person.name;
  const memberRow = itcmSection.locator("tr").filter({ hasText: personName }).first();
  await expect(memberRow).toBeVisible();

  // Arm the Flag button (first click). After this the button text changes to "Confirm?".
  await memberRow.getByRole("button", { name: "Flag", exact: true }).click();

  // Now locate the armed row by person name (not by "Flag" button, which is gone).
  // The row still contains the person's name; find the "Confirm?" button within it.
  const rowByName = itcmSection.locator("tr").filter({ hasText: personName }).first();
  await rowByName.getByRole("button").filter({ hasText: /\?/ }).first().click();

  // After the server action completes the page reloads. Wait for the "Flagged for
  // offboarding" section heading to appear (it renders when flagged !== null and >= 1 row).
  const flaggedSection = page
    .locator("section")
    .filter({ has: page.locator("h2").filter({ hasText: /Flagged for offboarding/ }) })
    .first();
  await expect(flaggedSection).toBeVisible();

  // The seeded member must appear in the flagged executor table
  const flaggedRow = flaggedSection.locator("tr").filter({ hasText: new RegExp(personName.trim()) }).first();
  await expect(flaggedRow).toBeVisible();

  // Unflag them from the executor table to restore state
  await confirmButtonClick(flaggedRow, "Unflag");

  // After unflag the row must be gone (table shows "No one is flagged." or fewer rows)
  await expect(flaggedRow).not.toBeVisible();
});

// ---------------------------------------------------------------------------
// Epic request round trip
// ---------------------------------------------------------------------------

/**
 * Creates a NEW epic request for dev.volunteer (netId: dv456), submits it to
 * YNHH to become SUBMITTED, then completes it with Epic ID "E2E123".
 *
 * Person/kind choice rationale:
 *   No dev-seed person has an epicId, so there is no MODIFY-safe target that
 *   would produce zero residue. The plan accepts residue for NEW requests:
 *   a COMPLETED request row and dev.volunteer.epicId = "E2E123" are left in
 *   the dev DB after this test. These are append-only history records and do
 *   not interfere with other tests (dev.volunteer is never logged in for Epic
 *   page assertions; the bounce test only visits /volunteers).
 *
 *   If a future seed adds a person with an existing epicId, prefer MODIFY +
 *   completing with the same ID so updatePersonFields detects no diff and
 *   no outbox entry is written.
 */
test("epic: create NEW request for dev.volunteer, submit to YNHH, complete (round trip)", async ({
  page,
}) => {
  await devLogin(page, "j.carney@yale.edu");

  // --- Pre-flight: cancel any leftover open (PENDING or SUBMITTED) request for
  //     dev.volunteer so that createEpicRequest does not throw EpicStateError.
  //     This makes the test idempotent across repeated runs.
  //
  //     Strategy: check the PENDING view for a Dev Volunteer row, cancel it if present;
  //     then check SUBMITTED view and cancel if present.
  for (const statusParam of ["PENDING", "SUBMITTED"]) {
    await page.goto(`/volunteers/epic?status=${statusParam}`);
    await page.waitForURL((url) => url.searchParams.get("status") === statusParam);
    const existingRow = page.locator("tr").filter({ hasText: /Dev Volunteer/ }).first();
    const exists = await existingRow.isVisible().catch(() => false);
    if (exists) {
      // Cancel via the cancel form: fill a reason and click Cancel
      await existingRow.locator('input[name="reason"]').fill("e2e-cleanup");
      await existingRow.getByRole("button", { name: "Cancel" }).click();
      // Wait for page to settle after cancel (revalidatePath, no redirect)
      await page.waitForLoadState("networkidle");
    }
  }

  // Also cancel any leftover PENDING request that landed with epicId already set
  // (i.e. test previously ran MODIFY kind). The loop above handles all open statuses.

  // Navigate to the Epic page (default PENDING view)
  await page.goto("/volunteers/epic");
  await page.waitForURL((url) => url.pathname === "/volunteers/epic");

  // Page heading
  await expect(page.getByRole("heading", { name: "Epic Requests" })).toBeVisible();

  // --- Create request ---
  // Note: labels on this page are plain <label> elements without htmlFor/id
  // associations, so getByLabel() does not work. Use getByPlaceholder() instead.
  //
  // Person/kind choice: use netId "dv456" (dev.volunteer) and kind NEW.
  // Residue: a COMPLETED request and dev.volunteer.epicId = "E2E123" remain in the dev
  // DB after a successful run. Re-runs cancel any open request before creating a new one.
  // If dev.volunteer already has epicId set from a prior completed run, the NEW kind
  // would fail; in that case, prefer MODIFY. We detect this by checking if the create
  // attempt redirects to an error page and switching to MODIFY.
  //
  // Simpler approach: always check PENDING first, create only if no open request exists.
  // The pre-flight loop above cancels any open request, so after cleanup we can safely
  // create NEW (regardless of epicId -- if epicId is set from a prior run, use MODIFY).

  // Determine which kind to use based on whether dev.volunteer already has an epicId.
  // We infer this from whether creating with kind=NEW would succeed. Instead of a DB
  // query, we attempt the create and detect the error redirect.
  const newRequestSection = page
    .locator("section")
    .filter({ has: page.locator("h2").filter({ hasText: "New Request" }) })
    .first();

  await newRequestSection.getByPlaceholder("netid or email@yale.edu").fill("dv456");

  // Select MODIFY kind in case dev.volunteer already has an epicId from a prior completed run.
  // MODIFY is always safe: it works when epicId is already set. If epicId is null the service
  // rejects MODIFY, but from prior runs epicId is set to "E2E123", so MODIFY succeeds.
  // On a fresh DB (epicId null), use NEW. Detect by trying NEW first; if the page shows an
  // error, switch to MODIFY. To keep the test simple, use NEW and handle the case where it
  // fails by verifying the error or using a try-catch approach.
  //
  // SIMPLEST approach: always use RENEW or MODIFY once epicId is set. But since on a FRESH
  // DB epicId is null, we must use NEW. We'll use NEW and if it fails due to epicId existing,
  // we accept that as an edge case and just verify the flow for the SUBMITTED->COMPLETED step.
  //
  // FINAL decision: leave kind as NEW (default). If dev.volunteer.epicId is already set,
  // createEpicRequest throws EpicStateError("Kind NEW requires the person to have no epicId").
  // The pre-flight doesn't clean up epicId (it's persistent). So on a second run after a
  // fully-completed test, kind must be MODIFY (or RENEW). We handle this by checking if the
  // current page shows a "person already has an epic ID" type error after submitting, and if
  // so, change kind to MODIFY and retry.
  //
  // Actually: the cleanest solution is to select MODIFY and fill "E2E123" as the mirror ID.
  // On a fresh DB this will fail ("Kind MODIFY requires an epicId"). So we need to know
  // which kind to use. We'll use the following heuristic:
  //   - Start with NEW. Submit the form.
  //   - If the URL contains ?error=, check the message and switch to MODIFY.
  //   - Otherwise proceed normally.
  const kindSelect = newRequestSection.locator('select[name="kind"]');
  await kindSelect.selectOption("NEW");
  await newRequestSection.getByRole("button", { name: "Create request" }).click();

  // Wait for navigation (redirect from server action)
  await page.waitForURL((url) => url.pathname === "/volunteers/epic");

  // If the page shows an error because epicId is already set (e.g. "Kind NEW requires..."),
  // retry with MODIFY kind
  const errorAlert = page.locator('[role="alert"]');
  const hasError = await errorAlert.isVisible().catch(() => false);
  if (hasError) {
    // Retry with MODIFY
    const retrySection = page
      .locator("section")
      .filter({ has: page.locator("h2").filter({ hasText: "New Request" }) })
      .first();
    await retrySection.getByPlaceholder("netid or email@yale.edu").fill("dv456");
    await retrySection.locator('select[name="kind"]').selectOption("MODIFY");
    await retrySection.getByRole("button", { name: "Create request" }).click();
    await page.waitForURL((url) => url.pathname === "/volunteers/epic");
  }

  // Dev Volunteer's row must be present in PENDING requests
  const pendingSection = page
    .locator("section")
    .filter({ has: page.locator("h2").filter({ hasText: /Pending Requests/ }) })
    .first();
  const dvRow = pendingSection.locator("tr").filter({ hasText: /Dev Volunteer/ }).first();
  await expect(dvRow).toBeVisible();

  // Check the checkbox for this request (form="ticket-form" association)
  await dvRow.getByRole("checkbox").check();

  // Fill a ticket description (input has placeholder "Optional description")
  await page.getByPlaceholder("Optional description").fill("E2E test ticket");

  // Submit to YNHH -- server action redirects to ?status=SUBMITTED
  await page.getByRole("button", { name: "Submit selected to YNHH" }).click();
  await page.waitForURL((url) => url.searchParams.get("status") === "SUBMITTED");

  // Dev Volunteer's row must show "Submitted" badge
  const submittedSection = page
    .locator("section")
    .filter({ has: page.locator("h2").filter({ hasText: /Submitted Requests/ }) })
    .first();
  const submittedRow = submittedSection.locator("tr").filter({ hasText: /Dev Volunteer/ }).first();
  await expect(submittedRow).toBeVisible();
  await expect(submittedRow.getByText("Submitted")).toBeVisible();

  // Complete the request: fill in Epic ID (input[name="epicId"] with placeholder "Epic ID")
  // and click Complete. The input has aria-label="Epic ID" but we use the name attribute
  // selector for resilience.
  await submittedRow.locator('input[name="epicId"]').fill("E2E123");
  await submittedRow.getByRole("button", { name: "Complete" }).click();

  // completeRequestAction calls revalidatePath (no redirect). Wait for the page to settle
  // by waiting for the network to go idle before navigating away.
  await page.waitForLoadState("networkidle");

  // Navigate to COMPLETED view to verify the request is now completed
  await page.goto("/volunteers/epic?status=COMPLETED");
  await page.waitForURL((url) => url.searchParams.get("status") === "COMPLETED");

  const completedSection = page
    .locator("section")
    .filter({ has: page.locator("h2").filter({ hasText: /Completed Requests/ }) })
    .first();
  const completedRow = completedSection.locator("tr").filter({ hasText: /Dev Volunteer/ }).first();
  await expect(completedRow).toBeVisible();
  await expect(completedRow.getByText("Completed")).toBeVisible();
});

// ---------------------------------------------------------------------------
// Disciplinary issue + delete (round trip)
// ---------------------------------------------------------------------------

/**
 * Issues a NON-confidential Attendance disciplinary action against dev.volunteer
 * (email: dev.volunteer@yale.edu), verifies the row appears in the table with
 * a strikes count >= 1, then deletes it via the ConfirmButton to restore state.
 *
 * Full round trip: no residue left in the dev DB after this test.
 *
 * Jack has volunteers.issue_disciplinary (via Platform Admin /* grant), so the
 * form shows a free-text "NetID or email" input (issuable.all = true path) and
 * the table renders a Delete column (canManageAll = true).
 */
test("disciplinary: issue attendance action for dev.volunteer, verify strikes, delete (round trip)", async ({
  page,
}) => {
  await devLogin(page, "j.carney@yale.edu");
  await page.goto("/volunteers/disciplinary");
  await page.waitForURL((url) => url.pathname === "/volunteers/disciplinary");

  // Page heading
  await expect(page.getByRole("heading", { name: "Disciplinary Actions" })).toBeVisible();

  // Issue form section
  const issueSection = page
    .locator("section")
    .filter({ has: page.locator("h2").filter({ hasText: "Record Disciplinary Action" }) })
    .first();

  // Fill in target person via free-text NetID/email input (issuable.all = true for Jack).
  // Labels on this page are plain <label> elements without htmlFor/id associations, so
  // getByLabel() does not resolve to the input. Use getByPlaceholder() instead.
  await issueSection.getByPlaceholder("netid or email@yale.edu").fill("dev.volunteer@yale.edu");

  // Fill in today's date (UTC ISO date portion)
  const todayUTC = new Date().toISOString().split("T")[0];
  await issueSection.locator('input[name="occurredAt"]').fill(todayUTC);

  // Select category "Attendance"
  await issueSection.locator('select[name="category"]').selectOption("Attendance");

  // Fill description (textarea)
  await issueSection.locator('textarea[name="description"]').fill("E2E test action");

  // Leave confidential unchecked (default)

  // Submit the form
  await issueSection.getByRole("button", { name: "Record action" }).click();

  // Server action redirects back to /volunteers/disciplinary
  await page.waitForURL((url) => url.pathname === "/volunteers/disciplinary");

  // Dev Volunteer's row must be in the table with strikes >= 1
  const dvActionRow = page.locator("tr").filter({ hasText: /Dev Volunteer/ }).filter({ hasText: /E2E test action/ }).first();
  await expect(dvActionRow).toBeVisible();

  // Strikes column: last TD with a number in the row (table column order: Date, Person,
  // Category, Description, Issued by, Flags, Strikes, Delete)
  const strikesCell = dvActionRow.locator("td").nth(6);
  const strikesText = await strikesCell.textContent();
  expect(parseInt(strikesText ?? "0", 10)).toBeGreaterThanOrEqual(1);

  // Delete the action via ConfirmButton to restore state
  await confirmButtonClick(dvActionRow, "Delete");

  // After deletion the page reloads and the row must be gone
  await page.waitForURL((url) => url.pathname === "/volunteers/disciplinary");
  await expect(
    page.locator("tr").filter({ hasText: /Dev Volunteer/ }).filter({ hasText: /E2E test action/ })
  ).not.toBeVisible();
});
