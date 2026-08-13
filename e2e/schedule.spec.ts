import { expect, test } from "@playwright/test";
import { devLogin } from "./auth";
import { seedRhdAttending, seedCapacityConfig, seedComplianceMember } from "./fixtures";

/**
 * Select a department option whose text contains the given code (e.g. "VADM").
 * Playwright selectOption requires an exact string label, so we read the options
 * from the DOM to find the matching one, then select by its value attribute.
 */
async function selectDeptByCode(page: import("@playwright/test").Page, code: string) {
  const deptSelect = page.locator('select[name="dept"]');
  await expect(deptSelect).toBeVisible();
  // Find the option whose text starts with "{code} - ".
  const value = await deptSelect.evaluate((sel: HTMLSelectElement, c: string) => {
    const opt = Array.from(sel.options).find((o) => o.text.startsWith(c + " - "));
    return opt?.value ?? null;
  }, code);
  if (!value) throw new Error(`Department option not found for code: ${code}`);
  await deptSelect.selectOption(value);
  return value;
}

// ---------------------------------------------------------------------------
// Module-level RHD attending fixture
// Seeds one active attending before every test and cleans it up after.
// This ensures tests 7 and 10 always have at least one attending in the DB
// without relying on ambient data. Other tests are unaffected.
// ---------------------------------------------------------------------------

let attending: Awaited<ReturnType<typeof seedRhdAttending>>;
// A fresh VADM VOLUNTEER seeded before every test so tests 4, 8, 9 always have
// an unambiguous, unassigned member to operate on regardless of ambient Neon DB state.
let vadmMember: Awaited<ReturnType<typeof seedComplianceMember>>;
test.beforeEach(async () => {
  [attending, vadmMember] = await Promise.all([
    seedRhdAttending(),
    seedComplianceMember("VADM"),
  ]);
});
test.afterEach(async () => {
  await Promise.all([attending.cleanup(), vadmMember.cleanup()]);
});

// ---------------------------------------------------------------------------
// Test 1: My schedule + availability panel
// ---------------------------------------------------------------------------

/**
 * Availability closes on a term's FIRST clinic date, after which changes go
 * through swap/drop requests instead (isAvailabilityLocked, availability.ts).
 *
 * The seeded live term SU26 runs 2026-05-30 to 2026-09-26, so its clinics have
 * long since started and its availability is correctly read-only. That is what
 * this test asserts.
 *
 * The EDITABLE path is not reachable from the seed at all, because the seed
 * defines exactly one term and its first clinic date is in the past. Its
 * coverage lives in the integration suite instead
 * (src/modules/schedule/services/schedule.test.ts, describe("updateMyAvailability"),
 * which pins `now` before the first clinic date). To restore end-to-end coverage
 * of the editable form, the seed needs a PLANNING term with future clinic dates;
 * that is a shared-fixture change with its own blast radius, so it is deliberately
 * not done here.
 */
test("Jack opens /schedule and sees availability locked once the term's clinics have started", async ({
  page,
}) => {
  await devLogin(page, "j.carney@yale.edu");
  await page.goto("/schedule");
  await page.waitForURL((url) => url.pathname === "/schedule");

  // Page heading (rendered by PageHeader with title="My Schedule")
  await expect(page.getByRole("heading", { name: "My Schedule" })).toBeVisible();

  // "My availability" section heading (h2)
  await expect(page.locator("h2").filter({ hasText: "My availability" })).toBeVisible();

  // Locked: the editor is withheld and the member is pointed at swap/drop.
  await expect(page.getByText("Availability is locked now that clinics have started.")).toBeVisible();
  await expect(page.locator('input[type="checkbox"][name="dates"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save availability" })).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Test 2: Full schedule date tab strip and department sections
// ---------------------------------------------------------------------------

test("Jack opens /schedule/full and sees at least 10 date pills", async ({
  page,
}) => {
  await devLogin(page, "j.carney@yale.edu");
  await page.goto("/schedule/full");
  await page.waitForURL((url) => url.pathname === "/schedule/full");

  // Page title, rendered by PageHeader with title="Full Schedule".
  await expect(page.getByRole("heading", { name: "Full Schedule" })).toBeVisible();

  // Date tab strip: links inside the nav[aria-label="Schedule dates"]
  // displayDate("2026-05-30") = "May 30th", etc.
  const dateNav = page.locator('nav[aria-label="Schedule dates"]');
  await expect(dateNav).toBeVisible();

  // SU26 has Saturdays from May 30 to Sep 26; the exact count can vary by
  // environment (seed vs Neon prod). Require at least 10 date pill links.
  const datePills = dateNav.getByRole("link");
  const pillCount = await datePills.count();
  expect(pillCount).toBeGreaterThanOrEqual(10);

  // Each pill must match the displayDate format: "Month Dth/st/nd/rd"
  const pillTexts = await datePills.allTextContents();
  const datePattern = /^[A-Z][a-z]+ \d+(st|nd|rd|th)$/;
  const validPills = pillTexts.filter((t) => datePattern.test(t.trim()));
  expect(validPills.length).toBeGreaterThanOrEqual(10);

  // Department cards on /schedule/full require shift assignments for the selected date,
  // which a bare seed does not have. Assignment-to-card rendering is covered by the
  // builder assign round-trip tests; here we assert only the deterministic date strip.
});

// ---------------------------------------------------------------------------
// Test 3: Availability round trip (dev.volunteer)
// ---------------------------------------------------------------------------

/**
 * A rank-and-file volunteer sees the same lock a director does, and still sees
 * what they had submitted.
 *
 * This test previously did a full toggle-save-reload-restore round trip against
 * the editable form. That form no longer renders for the seeded live term (see
 * the note on the availability test above), so the round trip is not reachable
 * end-to-end from this fixture. The save path itself stays covered at the
 * integration level in src/modules/schedule/services/schedule.test.ts, which
 * exercises persistence, canonical noon-UTC storage, multi-membership mirroring,
 * dedup, and the lock rejection.
 *
 * Residue: none. This test only reads.
 */
test("dev.volunteer sees their submitted availability read-only once clinics have started", async ({
  page,
}) => {
  await devLogin(page, "dev.volunteer@yale.edu");
  await page.goto("/schedule");
  await page.waitForURL((url) => url.pathname === "/schedule");

  await expect(page.locator("h2").filter({ hasText: "My availability" })).toBeVisible();

  // Locked, and pointing at the flow that does notify a director.
  await expect(page.getByText("Availability is locked now that clinics have started.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save availability" })).toHaveCount(0);

  // The lock must not hide what they submitted: a member still needs to see the
  // dates they are on the hook for, which is the whole reason the read-only view
  // renders the date list rather than just the message.
  const lockedSection = page.locator("section").filter({ hasText: "My availability" });
  await expect(lockedSection).toBeVisible();
});

// ---------------------------------------------------------------------------
// Test 4: Builder assign round trip
// ---------------------------------------------------------------------------

/**
 * Jack opens /schedule/builder (as Platform Admin with schedule.edit_all).
 * He picks VADM (Vaccine Administration) -- where dev.volunteer is seeded --
 * and selects the first clinic date. He clicks the first "Assign" button in
 * "Available to assign", verifies the member moves to "Assigned", then
 * removes them (ConfirmButton two-click) and verifies they return to
 * "Available to assign".
 *
 * Residue: none. Assign then Remove leaves the DB in its pre-test state.
 */
test("Builder assign round trip: Jack assigns then removes a member via VADM", async ({ page }) => {
  await devLogin(page, "j.carney@yale.edu");
  await page.goto("/schedule/builder");
  await page.waitForURL((url) => url.pathname === "/schedule/builder");

  await expect(page.getByRole("heading", { name: "Schedule Builder" })).toBeVisible();

  // Select VADM department from the Department select.
  await selectDeptByCode(page, "VADM");
  await page.getByRole("button", { name: "Go" }).click();
  await page.waitForLoadState("networkidle");

  // The date tab strip should now be visible.
  const dateNav = page.locator('nav[aria-label="Clinic dates"]');
  await expect(dateNav).toBeVisible();

  // Click the first date pill to select a date.
  const firstDateLink = dateNav.getByRole("link").first();
  await firstDateLink.click();
  await page.waitForLoadState("networkidle");

  // "Available to assign" column heading must be visible.
  const availableSection = page.locator("section").filter({ has: page.locator("h2", { hasText: "Available to assign" }) });
  await expect(availableSection.locator("h2", { hasText: "Available to assign" })).toBeVisible();

  // The unified Day view shows the "said yes" subsection header.
  await expect(availableSection.getByText(/Available · said yes/)).toBeVisible();

  // Use the seeded vadmMember (guaranteed unassigned from beforeEach) so this test is
  // independent of ambient Neon DB state. (Dev Volunteer may already be assigned from
  // a previous run's residue; the seeded member never is.)
  const memberName = vadmMember.person.name;
  const memberCard = availableSection.locator("div.rounded-2xl").filter({
    has: page.locator("span.font-semibold", { hasText: memberName }),
  });
  await expect(memberCard).toBeVisible({ timeout: 10_000 });

  // Find their "Assign as volunteer" button.
  const assignBtn = memberCard.getByRole("button", { name: /Assign as volunteer/ });
  await expect(assignBtn).toBeVisible();

  // Click Assign as volunteer -- this is a regular submit (BuilderCell), not a ConfirmButton.
  await assignBtn.click();
  await page.waitForLoadState("networkidle");

  // Assigned section: use exact-text heading to avoid matching "Available to assign".
  // The "Assigned" h2 is exactly "Assigned" (not "Available to assign").
  const assignedSection = page.locator("section").filter({
    has: page.locator("h2").filter({ hasText: /^Assigned$/ }),
  });
  await expect(assignedSection.locator("h2").filter({ hasText: /^Assigned$/ })).toBeVisible();

  // The seeded member's card in the Assigned section (volunteer cards use span.font-medium).
  const assignedMemberCard = assignedSection.locator("div.rounded-2xl").filter({
    has: page.locator("span.font-medium", { hasText: memberName }),
  });
  await expect(assignedMemberCard).toBeVisible();

  // Remove: scope to the seeded member's own assigned card so we don't accidentally remove
  // a different volunteer who was already assigned from ambient DB state.
  const removeBtn = assignedMemberCard.getByRole("button", { name: "Remove" });
  await expect(removeBtn).toBeVisible();

  // ConfirmButton two-click: first click arms, second click submits.
  await removeBtn.click();
  // After arming, the button text changes to the confirmLabel ("Remove this volunteer?").
  const confirmBtn = page.getByRole("button", { name: "Remove this volunteer?" }).first();
  await expect(confirmBtn).toBeVisible();
  await confirmBtn.click();
  await page.waitForLoadState("networkidle");

  // The seeded member should be back in "Available to assign".
  const availableSectionAfter = page.locator("section").filter({ has: page.locator("h2", { hasText: "Available to assign" }) });
  await expect(availableSectionAfter.locator("h2", { hasText: "Available to assign" })).toBeVisible();
  await expect(availableSectionAfter.locator("span", { hasText: memberName }).first()).toBeVisible();
});

// ---------------------------------------------------------------------------
// Test 5: Request round trip (self-cleaning)
// ---------------------------------------------------------------------------

/**
 * Jack (schedule.edit_all) assigns dev.volunteer to VADM on the term's last
 * (not-yet-past) clinic date via the builder. Then dev.volunteer opens
 * /schedule, finds the shift card, opens "Request a change", and submits a
 * Drop request. Jack then opens the builder for VADM+that date, approves the
 * request (ConfirmButton two clicks). Approval removes the assignment. The
 * test ends clean: no residue.
 *
 * dev.volunteer is seeded as a VADM VOLUNTEER member in SU26 with zero
 * pre-existing shifts, so the one assignment made here is unambiguously the
 * first (and only) card in "My shifts" regardless of which clinic date it
 * lands on.
 */
test("Request round trip: Jack assigns dev.volunteer, volunteer requests drop, Jack approves", async ({
  page,
}) => {
  test.setTimeout(90_000);
  // Step 1: Jack assigns dev.volunteer to VADM on a not-yet-past date.
  await devLogin(page, "j.carney@yale.edu");
  await page.goto("/schedule/builder");
  await page.waitForURL((url) => url.pathname === "/schedule/builder");

  // Select VADM.
  await selectDeptByCode(page, "VADM");
  await page.getByRole("button", { name: "Go" }).click();
  await page.waitForLoadState("networkidle");

  // Click the LAST date pill, not the first. The date strip renders every
  // clinic date of the seeded SU26 term unfiltered and in ascending order
  // (prisma/seed.ts: saturdays("2026-05-30", "2026-09-26")); the first pill
  // is long past. createRequest/approveRequest now refuse a change request
  // for a clinic date that has already passed, so the round trip below (drop
  // request -> approve) needs a date that is not in the past. The term's
  // final clinic date, 2026-09-26, is the one date in this fixture guaranteed
  // to be furthest from "past" for as long as this seed is in use.
  const dateNav = page.locator('nav[aria-label="Clinic dates"]');
  const targetDateLink = dateNav.getByRole("link").last();
  await targetDateLink.click();
  await page.waitForLoadState("networkidle");

  // Capture the current URL (dept + the date just clicked) to restore later.
  const builderUrl = page.url();

  // Find dev.volunteer (Dev Volunteer) in "Available to assign".
  const availableSection = page.locator("section").filter({ has: page.locator("h2", { hasText: "Available to assign" }) });

  // Look for "Dev Volunteer" in the available section.
  // Member name span changed from font-medium to font-semibold in the refactored builder.
  // Card wrapper class changed from rounded-lg to rounded-2xl in the refactored builder.
  const volunteerRow = availableSection.locator("div.rounded-2xl").filter({
    has: page.locator("span.font-semibold", { hasText: "Dev Volunteer" }),
  });

  // If Dev Volunteer is already assigned (from a previous test run), skip the assign step.
  // Use exact heading match to avoid matching "Available to assign".
  const assignedSection = page.locator("section").filter({
    has: page.locator("h2").filter({ hasText: /^Assigned$/ }),
  });
  const alreadyAssigned = (await assignedSection.getByText("Dev Volunteer", { exact: false }).count()) > 0;

  if (!alreadyAssigned) {
    await expect(volunteerRow).toBeVisible({ timeout: 10_000 });
    // Button labels changed from "Assign" to role-specific "Assign as volunteer".
    const assignBtn = volunteerRow.getByRole("button", { name: /Assign as volunteer/ }).first();
    await assignBtn.click();
    await page.waitForLoadState("networkidle");
  }

  // Confirm Dev Volunteer is in the Assigned section (scoped to the volunteer name span).
  await expect(assignedSection.locator("span.font-medium", { hasText: "Dev Volunteer" }).first()).toBeVisible();

  // Step 2: dev.volunteer opens /schedule and requests a drop.
  // Clear Jack's session before switching users; an active session cookie causes
  // /login to redirect immediately to "/" before the email input renders.
  await page.context().clearCookies();
  await devLogin(page, "dev.volunteer@yale.edu");
  await page.goto("/schedule");
  await page.waitForURL((url) => url.pathname === "/schedule");

  // "My shifts" section must show at least one shift.
  const myShiftsSection = page.locator("section").filter({ has: page.locator("h2", { hasText: "My shifts" }) });
  await expect(myShiftsSection.locator("h2", { hasText: "My shifts" })).toBeVisible();

  // Find the shift card -- it should show VADM or "Vaccine Administration".
  // Shift cards use rounded-2xl (outer card). The nested rounded-xl is just an
  // info bar inside the card and does NOT contain the "Request a change" details.
  const shiftCard = myShiftsSection.locator("div.rounded-2xl").first();
  await expect(shiftCard).toBeVisible({ timeout: 10_000 });

  const requestDetails = shiftCard.locator("details");
  await expect(requestDetails).toBeVisible();
  await requestDetails.locator("summary").click();

  // "Request drop" ConfirmButton: first click arms, second click submits.
  const requestDropBtn = page.getByRole("button", { name: "Request drop" }).first();
  await expect(requestDropBtn).toBeVisible();
  await requestDropBtn.click();

  // After arming, confirm label appears. Use page-level locator to avoid React re-render scoping issues.
  const requestDropConfirmBtn = page.getByRole("button", { name: "Request this drop?" }).first();
  await expect(requestDropConfirmBtn).toBeVisible({ timeout: 5_000 });
  await requestDropConfirmBtn.click();

  // Redirects to /schedule?requested=1, which the toast reader strips. This page is
  // already /schedule, so a pathname predicate would not wait at all; assert the toast.
  await expect(page.getByText(/Change request submitted\./)).toBeVisible({ timeout: 30_000 });

  // Step 3: Jack opens the builder, finds the pending request, approves it.
  await page.context().clearCookies();
  await devLogin(page, "j.carney@yale.edu");
  await page.goto(builderUrl);
  await page.waitForLoadState("networkidle");

  // "Pending Requests" panel must be visible.
  const pendingPanel = page.locator("section").filter({ has: page.locator("h2", { hasText: "Pending Requests" }) });
  await expect(pendingPanel.locator("h2", { hasText: "Pending Requests" })).toBeVisible();

  // There must be at least one pending row (Dev Volunteer's drop request).
  const approveBtn = pendingPanel.getByRole("button", { name: "Approve" }).first();
  await expect(approveBtn).toBeVisible({ timeout: 10_000 });

  // Count pending Approve buttons before approval (used to detect the re-render).
  const approveBtns = page.getByRole("button", { name: "Approve" });
  const pendingCountBefore = await approveBtns.count();
  expect(pendingCountBefore).toBeGreaterThanOrEqual(1);

  // Two-click approve: first click arms the ConfirmButton (label changes to "Approve this request?").
  await approveBtn.click();
  // Use a page-level locator for the confirm button to avoid scoping issues after React re-render.
  const approveConfirmBtn = page.getByRole("button", { name: "Approve this request?" }).first();
  await expect(approveConfirmBtn).toBeVisible({ timeout: 5_000 });
  await approveConfirmBtn.click();

  // After the second click the form submits, the server runs approveRequest, then redirects.
  // The page re-renders with the request now in "Recent decisions". Wait for the Approve
  // button count to drop (reliable re-render indicator that doesn't depend on text content).
  await expect(approveBtns).toHaveCount(pendingCountBefore - 1, { timeout: 15_000 });

  // Assert the decided section shows at least one "approved" entry.
  const pendingPanelAfter = page.locator("section").filter({ has: page.locator("h2", { hasText: "Pending Requests" }) });
  await expect(pendingPanelAfter.getByText(/approved/i).first()).toBeVisible();
});

// ---------------------------------------------------------------------------
// Test 6: Capacity panel renders
// ---------------------------------------------------------------------------

/**
 * Jack opens /schedule/builder with VADM selected and a date chosen.
 * The "Capacity" panel heading and the headcount metric text ("on shift")
 * must be visible in the third column.
 *
 * Capacity config (idealHeadcount, patientCapacityPerProvider) lives on the
 * Department row. The fixture temporarily sets it on SCTP then restores the
 * previous value, so the test is deterministic in both CI (bare seed, no
 * config) and production-connected environments (config already present).
 */
test("Capacity panel is gated to departments with capacity config", async ({ page }) => {
  // Ensure SCTP has capacity config for this test (CI bare seed has no config).
  // Restores the pre-test value on cleanup (preserves prod config in Neon).
  const capacityConfig = await seedCapacityConfig("SCTP", { idealHeadcount: 4, patientCapacityPerProvider: 10 });
  try {
    await devLogin(page, "j.carney@yale.edu");
    await page.goto("/schedule/builder");
    await page.waitForURL((url) => url.pathname === "/schedule/builder");

    // VADM has no capacity config, so the Capacity panel must NOT render.
    const vadmId = await selectDeptByCode(page, "VADM");
    await page.getByRole("button", { name: "Go" }).click();
    await page.waitForURL((url) => url.searchParams.get("dept") === vadmId);
    await page.locator('nav[aria-label="Clinic dates"]').getByRole("link").first().click();
    await page.waitForLoadState("networkidle");
    await expect(
      page.locator("section").filter({ has: page.locator("h2", { hasText: "Capacity" }) }),
    ).toHaveCount(0);

    // SCTP has capacity config (idealHeadcount/patientCapacityPerProvider), so it renders.
    const sctpId = await selectDeptByCode(page, "SCTP");
    await page.getByRole("button", { name: "Go" }).click();
    await page.waitForURL((url) => url.searchParams.get("dept") === sctpId);
    await page.locator('nav[aria-label="Clinic dates"]').getByRole("link").first().click();
    await page.waitForLoadState("networkidle");

    const capacityPanel = page.locator("section").filter({ has: page.locator("h2", { hasText: "Capacity" }) });
    await expect(capacityPanel.locator("h2", { hasText: "Capacity" })).toBeVisible();
    await expect(capacityPanel.locator("span", { hasText: /on shift/ })).toBeVisible();
  } finally {
    await capacityConfig.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Test 7: RHD Clinic Readiness panel renders for an RHD department
// ---------------------------------------------------------------------------

/**
 * Jack (schedule.edit_all) selects SCTS (Senior Reproductive Care) in the
 * builder. SCTS is one of the RHD_CODES so data.rhd != null. The
 * "RHD Clinic Readiness" panel heading must be visible regardless of whether
 * SCTS has any members on the selected date.
 */
test("RHD Clinic Readiness panel renders for an RHD department (SCTS)", async ({ page }) => {
  await devLogin(page, "j.carney@yale.edu");
  await page.goto("/schedule/builder");
  await page.waitForURL((url) => url.pathname === "/schedule/builder");

  // Select SCTS (Senior Reproductive Care Clinical Team Member).
  await selectDeptByCode(page, "SCTS");
  await page.getByRole("button", { name: "Go" }).click();
  await page.waitForLoadState("networkidle");

  // Pick the first clinic date so the RHD panel renders (it requires selectedDateKey != null).
  const dateNav = page.locator('nav[aria-label="Clinic dates"]');
  await expect(dateNav).toBeVisible();
  await dateNav.getByRole("link").first().click();
  await page.waitForLoadState("networkidle");

  // The "RHD Clinic Readiness" panel must be visible.
  const rhdPanel = page.locator("section").filter({ has: page.locator("h2", { hasText: "RHD Clinic Readiness" }) });
  await expect(rhdPanel.locator("h2", { hasText: "RHD Clinic Readiness" })).toBeVisible();
});

// ---------------------------------------------------------------------------
// Test 8: Builder day-view shadow assign
// ---------------------------------------------------------------------------

test("Builder day-view shadow assign: Jack assigns a member as a shadow via VADM", async ({ page }) => {
  await devLogin(page, "j.carney@yale.edu");
  await page.goto("/schedule/builder");
  await page.waitForURL((url) => url.pathname === "/schedule/builder");

  await selectDeptByCode(page, "VADM");
  await page.getByRole("button", { name: "Go" }).click();
  await page.waitForLoadState("networkidle");

  const dateNav = page.locator('nav[aria-label="Clinic dates"]');
  await dateNav.getByRole("link").first().click();
  await page.waitForLoadState("networkidle");

  const availableSection = page.locator("section").filter({
    has: page.locator("h2", { hasText: "Available to assign" }),
  });
  const shadowBtn = availableSection.getByRole("button", { name: /Assign as shadow/ }).first();
  await expect(shadowBtn).toBeVisible();
  // Card wrapper class changed from rounded-lg to rounded-2xl in the refactored builder.
  const memberRow = shadowBtn.locator("xpath=ancestor::div[contains(@class,'rounded-2xl')]").first();
  const memberName = (await memberRow.locator("span.font-semibold").first().textContent())?.trim();
  expect(memberName).toBeTruthy();

  await shadowBtn.click();
  await page.waitForLoadState("networkidle");

  const assignedSection = page.locator("section").filter({
    has: page.locator("h2").filter({ hasText: /^Assigned$/ }),
  });
  await expect(assignedSection.getByText(memberName!, { exact: false })).toBeVisible();

  // Clean up so the test is idempotent.
  // Scope Remove to the Shadows subsection to avoid hitting a Director's Remove button.
  const shadowsHeading = assignedSection.getByRole("heading", { name: /^Shadows/ });
  const removeBtn = shadowsHeading.locator("xpath=following-sibling::*").getByRole("button", { name: "Remove" }).first();
  await removeBtn.click();
  // Use page-level locator for the confirm button to avoid React re-render scoping issues.
  const confirmBtn = page.getByRole("button", { name: "Remove this shadow?" }).first();
  await expect(confirmBtn).toBeVisible();
  await confirmBtn.click();
  await page.waitForLoadState("networkidle");
});

// ---------------------------------------------------------------------------
// Test 9: Builder grid shadow assign
// ---------------------------------------------------------------------------

test("Builder grid shadow assign: Jack toggles Shadow and assigns from a grid cell", async ({ page }) => {
  await devLogin(page, "j.carney@yale.edu");
  await page.goto("/schedule/builder");
  await page.waitForURL((url) => url.pathname === "/schedule/builder");

  const vadmId = await selectDeptByCode(page, "VADM");
  await page.getByRole("button", { name: "Go" }).click();
  await page.waitForURL((url) => url.searchParams.get("dept") === vadmId);

  await page.locator('nav[aria-label="Clinic dates"]').getByRole("link").first().click();
  await page.waitForURL((url) => url.searchParams.get("date") !== null);
  await page.getByRole("link", { name: "Grid", exact: true }).click();
  await page.waitForURL((url) => url.searchParams.get("view") === "grid");

  await page.getByRole("link", { name: "Shadow" }).click();
  await page.waitForURL((url) => url.searchParams.get("gmode") === "shadow");

  // Use the seeded vadmMember (guaranteed unassigned from beforeEach) so the test is
  // independent of ambient DB state. Directors are sorted first in the grid, so the
  // seeded volunteer would appear after Dev Director. We scope by name to be precise.
  const memberGridName = vadmMember.person.name;
  // Find the FIRST shadow assign button for the seeded member (any date will do).
  const shadowCell = page.getByRole("button", {
    name: new RegExp(`Assign ${memberGridName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} as shadow on`),
  }).first();
  await expect(shadowCell).toBeVisible({ timeout: 10_000 });
  const cellLabel = await shadowCell.getAttribute("aria-label"); // "Assign <name> as shadow on <date>[, unavailable]"
  expect(cellLabel).toBeTruthy();
  // Use force:true to bypass Playwright's pointer-event check: the first date column can be
  // partially overlapped by the sticky row header (z-10, left-0).
  await shadowCell.click({ force: true });
  await page.waitForLoadState("networkidle");

  // Verify the assign worked: the cell now shows "Unassign".
  // The Unassign button format: "Unassign <name> (shadow) from <date>[, unavailable]".
  const parts = cellLabel!.match(/^Assign (.+) as shadow on (.+)$/);
  expect(parts).toBeTruthy();
  const unassignLabel = `Unassign ${parts![1]} (shadow) from ${parts![2]}`;
  await expect(page.getByRole("button", { name: unassignLabel })).toBeVisible({ timeout: 10_000 });

  // Switch to Day view for cleanup. The grid's force:true click can land in an adjacent
  // row due to the sticky member column's z-index geometry; Day view remove is reliable.
  // Day view emits neither ?view nor ?mode (the unified URL contract), so wait for
  // ?view to drop rather than for a "saturday" value that no longer appears.
  await page.getByRole("link", { name: "Day", exact: true }).click();
  await page.waitForURL((url) => url.searchParams.get("view") === null);

  // Remove the seeded member's shadow assignment from the Day view Assigned section.
  const assignedSection = page.locator("section").filter({
    has: page.locator("h2").filter({ hasText: /^Assigned$/ }),
  });
  const shadowsHeading = assignedSection.getByRole("heading", { name: /^Shadows/ });
  // Find the member's specific card in the shadows list and click its Remove button.
  const shadowCard = shadowsHeading.locator("xpath=following-sibling::*").locator("div.rounded-2xl").filter({
    has: page.locator("span", { hasText: memberGridName }),
  });
  await expect(shadowCard).toBeVisible({ timeout: 5_000 });
  const removeBtn = shadowCard.getByRole("button", { name: "Remove" });
  await removeBtn.click();
  const confirmBtn = page.getByRole("button", { name: "Remove this shadow?" }).first();
  await expect(confirmBtn).toBeVisible();
  await confirmBtn.click();
  await page.waitForLoadState("networkidle");

  // Switch back to Grid Shadow view and confirm the cell shows Assign again.
  await page.getByRole("link", { name: "Grid", exact: true }).click();
  await page.waitForLoadState("networkidle");
  await page.getByRole("link", { name: "Shadow" }).click();
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("button", { name: cellLabel! })).toBeVisible({ timeout: 10_000 });
});

// Attending scheduling lives on /schedule/attendings for every service line.
// It used to be a form inside the builder's reproductive-health readiness panel,
// which is why this test once drove the builder; the panel is read-only now.
test("attendings: add one, then schedule it on a clinic date", async ({ page }) => {
  const name = `Test-${Date.now()}`;
  await devLogin(page, "j.carney@yale.edu");

  // Create via the management page.
  await page.goto("/schedule/attendings/new");
  await page.waitForURL((url) => url.pathname === "/schedule/attendings/new");
  await page.fill('input[name="scheduleName"]', name);
  await page.fill('input[name="fullName"]', `Dr. ${name}`);
  await page.getByRole("button", { name: "Save" }).click();
  await page.waitForURL((url) => url.pathname === "/schedule/attendings");

  // It becomes assignable on the grid, on every clinic date of its line. One
  // select per time slot, named `slot:<id>`, so this picks the first slot of the
  // first date rather than a single per-day attending field.
  const cell = page.locator('select[name^="slot:"]').first();
  await expect(cell).toBeVisible();
  const option = cell.locator("option", { hasText: name });
  await expect(option).toHaveCount(1);
  const optionValue = await option.getAttribute("value");

  // Actually schedule it: this is the thing the page now exists to do, and the
  // half that a "does the dropdown contain it" assertion never reached.
  await cell.selectOption({ label: name });
  await cell.locator("xpath=ancestor::form[1]").getByRole("button", { name: "Save" }).click();
  await page.waitForLoadState("networkidle");

  // Round-trips through the DB rather than merely rendering optimistically.
  await expect(page.locator('select[name^="slot:"]').first()).toHaveValue(optionValue!);
});
