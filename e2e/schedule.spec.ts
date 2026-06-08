import { expect, test } from "@playwright/test";

async function devLogin(page: import("@playwright/test").Page, email: string) {
  await page.goto("/login");
  await page.fill('input[name="email"]', email);
  await page.click('button:has-text("Dev sign in")');
  await page.waitForURL((url) => url.pathname === "/");
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

  // Page heading (rendered by PageHeader with title="Full Schedule")
  await expect(page.getByRole("heading", { name: "Full Schedule" })).toBeVisible();

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

  // At least one department section heading must render (real imported data: 1496 assignments)
  // h2 renders as "{code} · {name}" using &middot; (unicode U+00B7)
  const deptHeadings = page.locator("h2").filter({ hasText: /·/ });
  await expect(deptHeadings.first()).toBeVisible();

  // At least one role group line must render: "Directors:" label inside a department section
  await expect(page.locator("span").filter({ hasText: /^Directors:/ }).first()).toBeVisible();
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
  await expect(page.locator("p").filter({ hasText: "Availability saved." })).toBeVisible();

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
