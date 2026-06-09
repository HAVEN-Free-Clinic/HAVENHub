import { expect, test } from "@playwright/test";

async function devLogin(page: import("@playwright/test").Page, email: string) {
  // Clear session cookies so we always arrive at the login page unauthenticated,
  // even if a different user is already signed in.
  await page.context().clearCookies();
  await page.goto("/login");
  await page.fill('input[name="email"]', email);
  await page.click('button:has-text("Dev sign in")');
  await page.waitForURL((url) => url.pathname === "/");
}

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

  // SU26 has 18 Saturdays; at least 10 date pill links must render
  const datePills = dateNav.getByRole("link");
  await expect(datePills).toHaveCount(18);

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

  // Find the first "Assign as volunteer" button in the "Available to assign" section.
  // Button labels changed from plain "Assign" to role-specific "Assign as volunteer",
  // "Assign as shadow", "Assign as director" in the refactored builder.
  const assignBtn = availableSection.getByRole("button", { name: /Assign as volunteer/ }).first();
  await expect(assignBtn).toBeVisible();

  // Capture the member name from the row containing the Assign button.
  // Member name span changed from font-medium to font-semibold in the refactored builder.
  const memberRow = assignBtn.locator("xpath=ancestor::div[contains(@class,'rounded-lg')]").first();
  const memberName = await memberRow.locator("span.font-semibold").first().textContent();
  expect(memberName).toBeTruthy();

  // Click Assign as volunteer -- this is a regular submit (BuilderCell), not a ConfirmButton.
  await assignBtn.click();
  await page.waitForLoadState("networkidle");

  // Assigned section: use exact-text heading to avoid matching "Available to assign".
  // The "Assigned" h2 is exactly "Assigned" (not "Available to assign").
  const assignedSection = page.locator("section").filter({
    has: page.locator("h2").filter({ hasText: /^Assigned$/ }),
  });
  await expect(assignedSection.locator("h2").filter({ hasText: /^Assigned$/ })).toBeVisible();

  // The member name should appear in the Assigned section (scoped to the volunteer span).
  await expect(assignedSection.locator("span.font-medium", { hasText: memberName!.trim() }).first()).toBeVisible();

  // Now remove: find the "Remove" ConfirmButton in the Volunteers subsection.
  // Use the Volunteers paragraph to scope the Remove button to avoid hitting a Director's Remove.
  const volunteerPara = assignedSection.locator("p", { hasText: /^Volunteers/ });
  const removeBtn = volunteerPara.locator("xpath=following-sibling::*").getByRole("button", { name: "Remove" }).first();
  await expect(removeBtn).toBeVisible();

  // ConfirmButton two-click: first click arms, second click submits.
  await removeBtn.click();
  // After arming, the button text changes to the confirmLabel ("Remove this volunteer?").
  const confirmBtn = page.getByRole("button", { name: "Remove this volunteer?" }).first();
  await expect(confirmBtn).toBeVisible();
  await confirmBtn.click();
  await page.waitForLoadState("networkidle");

  // The member should be back in "Available to assign" (either subsection).
  const availableSectionAfter = page.locator("section").filter({ has: page.locator("h2", { hasText: "Available to assign" }) });
  await expect(availableSectionAfter.locator("h2", { hasText: "Available to assign" })).toBeVisible();
  await expect(availableSectionAfter.locator("span", { hasText: memberName!.trim() }).first()).toBeVisible();
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
  const volunteerRow = availableSection.locator("div.rounded-lg").filter({
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
  await devLogin(page, "dev.volunteer@yale.edu");
  await page.goto("/schedule");
  await page.waitForURL((url) => url.pathname === "/schedule");

  // "My shifts" section must show at least one shift.
  const myShiftsSection = page.locator("section").filter({ has: page.locator("h2", { hasText: "My shifts" }) });
  await expect(myShiftsSection.locator("h2", { hasText: "My shifts" })).toBeVisible();

  // Find the shift card -- it should show VADM or "Vaccine Administration".
  // Open the "Request a change" details element.
  const shiftCard = myShiftsSection.locator("div.rounded-xl").first();
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
 */
test("Capacity panel is gated to departments with capacity config", async ({ page }) => {
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
  const memberRow = shadowBtn.locator("xpath=ancestor::div[contains(@class,'rounded-lg')]").first();
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

  const shadowCell = page.getByRole("button", { name: /as shadow on/ }).first();
  await expect(shadowCell).toBeVisible();
  const cellLabel = await shadowCell.getAttribute("aria-label"); // "Assign <name> as shadow on <date>"
  expect(cellLabel).toBeTruthy();
  await shadowCell.click();
  await page.waitForLoadState("networkidle");

  // Unassign the SAME member+date we just assigned, derived from the cell's label.
  const parts = cellLabel!.match(/^Assign (.+) as shadow on (.+)$/);
  expect(parts).toBeTruthy();
  const unassignShadow = page.getByRole("button", {
    name: `Unassign ${parts![1]} (shadow) from ${parts![2]}`,
  });
  await expect(unassignShadow).toBeVisible();
  await unassignShadow.click();
  await page.waitForLoadState("networkidle");

  // The same cell reverts to an assignable shadow cell.
  await expect(page.getByRole("button", { name: cellLabel! })).toBeVisible();
});
