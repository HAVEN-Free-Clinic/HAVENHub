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
