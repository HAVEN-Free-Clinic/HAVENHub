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

test("Jack opens /schedule and sees the My availability heading and Save availability button", async ({
  page,
}) => {
  await devLogin(page, "j.carney@yale.edu");
  await page.goto("/schedule");
  await page.waitForURL((url) => url.pathname === "/schedule");

  // Page heading (rendered by PageHeader with title="My Schedule")
  await expect(page.getByRole("heading", { name: "My Schedule" })).toBeVisible();

  // "My availability" section heading (h2)
  await expect(page.locator("h2").filter({ hasText: "My availability" })).toBeVisible();

  // At least one clinic-date checkbox must be present
  // The form renders one checkbox per clinic date in the active term (SU26 has 18 Saturdays)
  const firstCheckbox = page.locator('input[type="checkbox"][name="dates"]').first();
  await expect(firstCheckbox).toBeVisible();

  // Save availability button
  await expect(page.getByRole("button", { name: "Save availability" })).toBeVisible();
});

// ---------------------------------------------------------------------------
// Test 2: Full schedule date tab strip and department sections
// ---------------------------------------------------------------------------

test("Jack opens /schedule/full and sees at least 10 date pills and a department h2", async ({
  page,
}) => {
  await devLogin(page, "j.carney@yale.edu");
  await page.goto("/schedule/full");
  await page.waitForURL((url) => url.pathname === "/schedule/full");

  // Hero eyebrow label ("Full Schedule"); the h1 now renders the selected date.
  await expect(page.locator("p").filter({ hasText: "Full Schedule" }).first()).toBeVisible();

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

  // At least one department card must render (real imported data: 1496 assignments).
  // The card header shows the dept code in a font-black uppercase span.
  const deptCode = page.locator("span.font-black.uppercase");
  await expect(deptCode.first()).toBeVisible();

  // At least one role group label ("Directors") must render inside a department card.
  await expect(page.locator("p").filter({ hasText: /^Directors$/ }).first()).toBeVisible();
});

// ---------------------------------------------------------------------------
// Test 3: Availability round trip (dev.volunteer)
// ---------------------------------------------------------------------------

/**
 * dev.volunteer (dev.volunteer@yale.edu, VADM VOLUNTEER) opens /schedule,
 * toggles the FIRST checkbox (checking if unchecked, unchecking if checked),
 * saves, verifies persistence via reload, then restores the original state.
 *
 * Residue: none. The second save restores exactly the original availability,
 * leaving the DB in its pre-test state.
 *
 * Note: dev.volunteer has an ACTIVE VADM membership in SU26. The availability
 * form renders up to 18 date checkboxes. The test is agnostic about which
 * dates are pre-checked.
 */
test("dev.volunteer availability round trip: toggle first checkbox, save, reload, verify, restore", async ({
  page,
}) => {
  await devLogin(page, "dev.volunteer@yale.edu");
  await page.goto("/schedule");
  await page.waitForURL((url) => url.pathname === "/schedule");

  // The availability form must be present (dev.volunteer is on the SU26 roster)
  const firstCheckbox = page.locator('input[type="checkbox"][name="dates"]').first();
  await expect(firstCheckbox).toBeVisible();

  // Record initial state
  const wasChecked = await firstCheckbox.isChecked();

  // Toggle: uncheck if checked, check if unchecked
  if (wasChecked) {
    await firstCheckbox.uncheck();
  } else {
    await firstCheckbox.check();
  }

  // Capture the date value so we can re-identify the checkbox after reload
  const dateValue = await firstCheckbox.getAttribute("value");
  expect(dateValue).not.toBeNull();

  // Save
  await page.getByRole("button", { name: "Save availability" }).click();

  // After save the server redirects to /schedule?saved=1
  await page.waitForURL((url) => url.pathname === "/schedule" && url.searchParams.get("saved") === "1");

  // Success indicator must be visible
  await expect(page.getByText("Availability saved successfully.")).toBeVisible();

  // Reload to confirm persistence (a fresh server render reads from the DB)
  await page.goto("/schedule");
  await page.waitForURL((url) => url.pathname === "/schedule");

  // Re-locate the same checkbox by its date value
  const checkboxAfterReload = page.locator(`input[type="checkbox"][name="dates"][value="${dateValue}"]`);
  await expect(checkboxAfterReload).toBeVisible();

  // The state must have flipped
  const newChecked = await checkboxAfterReload.isChecked();
  expect(newChecked).toBe(!wasChecked);

  // --- Restore original state ---
  if (newChecked) {
    await checkboxAfterReload.uncheck();
  } else {
    await checkboxAfterReload.check();
  }

  await page.getByRole("button", { name: "Save availability" }).click();
  await page.waitForURL((url) => url.pathname === "/schedule" && url.searchParams.get("saved") === "1");

  // Confirm restored
  await page.goto("/schedule");
  await page.waitForURL((url) => url.pathname === "/schedule");

  const checkboxRestored = page.locator(`input[type="checkbox"][name="dates"][value="${dateValue}"]`);
  await expect(checkboxRestored).toBeVisible();
  expect(await checkboxRestored.isChecked()).toBe(wasChecked);
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

  // "Schedule Builder" renders as a paragraph (breadcrumb) in the refactored builder layout.
  await expect(page.locator("p", { hasText: "Schedule Builder" })).toBeVisible();

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
 * Jack (schedule.edit_all) assigns dev.volunteer to VADM on the first clinic
 * date via the builder. Then dev.volunteer opens /schedule, finds the shift
 * card, opens "Request a change", and submits a Drop request. Jack then opens
 * the builder for VADM+that date, approves the request (ConfirmButton two
 * clicks). Approval removes the assignment. The test ends clean: no residue.
 *
 * dev.volunteer is seeded as a VADM VOLUNTEER member in SU26.
 */
test("Request round trip: Jack assigns dev.volunteer, volunteer requests drop, Jack approves", async ({
  page,
}) => {
  test.setTimeout(90_000);
  // Step 1: Jack assigns dev.volunteer to VADM on the first date.
  await devLogin(page, "j.carney@yale.edu");
  await page.goto("/schedule/builder");
  await page.waitForURL((url) => url.pathname === "/schedule/builder");

  // Select VADM.
  await selectDeptByCode(page, "VADM");
  await page.getByRole("button", { name: "Go" }).click();
  await page.waitForLoadState("networkidle");

  // Click the first date pill.
  const dateNav = page.locator('nav[aria-label="Clinic dates"]');
  const firstDateLink = dateNav.getByRole("link").first();
  await firstDateLink.click();
  await page.waitForLoadState("networkidle");

  // Capture the current URL to restore dept+date params later.
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

  // Redirect to /schedule?requested=1.
  await page.waitForURL((url) => url.pathname === "/schedule" && url.searchParams.get("requested") === "1", { timeout: 15_000 });
  await expect(page.getByText(/Change request submitted\./)).toBeVisible();

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
    await selectDeptByCode(page, "VADM");
    await page.getByRole("button", { name: "Go" }).click();
    await page.waitForLoadState("networkidle");
    await page.locator('nav[aria-label="Clinic dates"]').getByRole("link").first().click();
    await page.waitForLoadState("networkidle");
    await expect(
      page.locator("section").filter({ has: page.locator("h2", { hasText: "Capacity" }) }),
    ).toHaveCount(0);

    // SCTP has capacity config (idealHeadcount/patientCapacityPerProvider), so it renders.
    await selectDeptByCode(page, "SCTP");
    await page.getByRole("button", { name: "Go" }).click();
    await page.waitForLoadState("networkidle");
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
  const shadowsPara = assignedSection.locator("p", { hasText: /^Shadows/ });
  const removeBtn = shadowsPara.locator("xpath=following-sibling::*").getByRole("button", { name: "Remove" }).first();
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

  await selectDeptByCode(page, "VADM");
  await page.getByRole("button", { name: "Go" }).click();
  await page.waitForLoadState("networkidle");

  await page.locator('nav[aria-label="Clinic dates"]').getByRole("link").first().click();
  await page.waitForLoadState("networkidle");
  await page.getByRole("link", { name: "Grid view" }).click();
  await page.waitForLoadState("networkidle");

  await page.getByRole("link", { name: "Shadow" }).click();
  await page.waitForLoadState("networkidle");

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
  await page.getByRole("link", { name: "Day view" }).click();
  await page.waitForLoadState("networkidle");

  // Remove the seeded member's shadow assignment from the Day view Assigned section.
  const assignedSection = page.locator("section").filter({
    has: page.locator("h2").filter({ hasText: /^Assigned$/ }),
  });
  const shadowsPara = assignedSection.locator("p", { hasText: /^Shadows/ });
  // Find the member's specific card in the shadows list and click its Remove button.
  const shadowCard = shadowsPara.locator("xpath=following-sibling::*").locator("div.rounded-2xl").filter({
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
  await page.getByRole("link", { name: "Grid view" }).click();
  await page.waitForLoadState("networkidle");
  await page.getByRole("link", { name: "Shadow" }).click();
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("button", { name: cellLabel! })).toBeVisible({ timeout: 10_000 });
});

test("RHD attendings: add one and see it in the readiness dropdown", async ({ page }) => {
  const name = `Test-${Date.now()}`;
  await devLogin(page, "j.carney@yale.edu");

  // Create via the management page.
  await page.goto("/schedule/attendings/new");
  await page.waitForURL((url) => url.pathname === "/schedule/attendings/new");
  await page.fill('input[name="scheduleName"]', name);
  await page.fill('input[name="fullName"]', `Dr. ${name}`);
  await page.getByRole("button", { name: "Save" }).click();
  await page.waitForURL((url) => url.pathname === "/schedule/attendings");
  await expect(page.getByText(name, { exact: true })).toBeVisible();

  // It appears in the builder readiness Attending dropdown for an RHD dept (SCTS).
  await page.goto("/schedule/builder");
  await selectDeptByCode(page, "SCTS");
  await page.getByRole("button", { name: "Go" }).click();
  await page.waitForLoadState("networkidle");
  await page.locator('nav[aria-label="Clinic dates"]').getByRole("link").first().click();
  await page.waitForLoadState("networkidle");

  const attendingSelect = page.locator('select[name="attendingId"]');
  await expect(attendingSelect).toBeVisible();
  await expect(attendingSelect.locator("option", { hasText: name })).toHaveCount(1);
});
