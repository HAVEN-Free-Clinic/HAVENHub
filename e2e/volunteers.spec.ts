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
  // First click: arm the button (it switches to danger variant and to the caller's
  // confirmLabel, which always ends in "?" -- see confirm-label.guard.test.ts)
  await container.getByRole("button", { name: label, exact: true }).click();
  // Second click: the armed button text ends with "?" -- click whatever danger button
  // appeared in the same container.
  await container.getByRole("button").filter({ hasText: /\?/ }).first().click();
}

// /volunteers is the one compliance roster (the master view merged into it),
// so the roster assertions below are made there. /volunteers/master is a
// redirect, covered further down.
const ROSTER_RESOLVED = /^([\d,]+ members?|No members yet|No members match these filters)$/;

test("Jack opens /volunteers and sees the one compliance roster", async ({ page }) => {
  await devLogin(page, "j.carney@yale.edu");
  await page.goto("/volunteers");
  await page.waitForURL((url) => url.pathname === "/volunteers");

  await expect(page.getByRole("heading", { name: "Compliance", exact: true })).toBeVisible();
  // The count line (or empty state) renders only once the streamed body has
  // resolved, so this proves the roster loaded rather than its skeleton.
  await expect(page.getByText(ROSTER_RESOLVED)).toBeVisible();
});

test("Jack sees at least one status Badge on the ITCM compliance page", async ({ page }) => {
  await devLogin(page, "j.carney@yale.edu");
  await page.goto("/volunteers");
  await page.waitForURL((url) => url.pathname === "/volunteers");

  // At least one status badge must be visible in the table.
  // The beforeEach seeds an ITCM member with a COMPLIANT cert, so a badge is guaranteed.
  // Status labels come from complianceStatusLabel(status, "staff") in
  // platform/compliance/labels.ts. Keep this set in step with that map.
  const statusBadge = page
    .locator("td span")
    .filter({
      hasText: /^(Compliant|Expiring soon|Expired|Date unknown|Needs verification|No certificate)$/,
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

test("Jack (Platform Admin) opens /volunteers and sees the summary cards", async ({ page }) => {
  await devLogin(page, "j.carney@yale.edu");
  await page.goto("/volunteers");
  await page.waitForURL((url) => url.pathname === "/volunteers");

  // Page heading must be visible
  await expect(page.getByRole("heading", { name: "Compliance", exact: true })).toBeVisible();

  // Wait out the Suspense fallback before asserting on the cards. The skeleton
  // carries the real card LABELS (so the swap does not shift the layout), which
  // means the assertions below would pass against a placeholder and prove
  // nothing. The roster count line is rendered only by the resolved body.
  // The count line renders only when the roster has rows; an empty roster shows
  // ListEmpty instead, whose wording depends on whether a filter is set. Accept
  // any of the three, so this stays a "body resolved" signal rather than an
  // assertion about how many members the seed happens to have.
  await expect(page.getByText(ROSTER_RESOLVED)).toBeVisible();

  // Summary stat cards are rendered as plain <p> elements (no aria-label).
  // The beforeEach seeds a COMPLIANT ITCM member, so "Compliant" will always be present.
  // "No certificate" covers seed members with no cert, so it is also always present.
  await expect(page.locator("p").filter({ hasText: /^Compliant$/ }).first()).toBeVisible();
  await expect(page.locator("p").filter({ hasText: /^No certificate$/ }).first()).toBeVisible();
});

test("Jack sees the filter bar on /volunteers", async ({ page }) => {
  await devLogin(page, "j.carney@yale.edu");
  await page.goto("/volunteers");
  await page.waitForURL((url) => url.pathname === "/volunteers");

  // Filter bar inputs must be present
  await expect(page.getByPlaceholder("Name, NetID, or email…")).toBeVisible();
});

test("the old /volunteers/master URL lands on the roster with its filters", async ({ page }) => {
  // Bookmarks and the review links already in inboxes point here.
  await devLogin(page, "j.carney@yale.edu");
  await page.goto("/volunteers/master?q=zz-no-such-member");
  await page.waitForURL((url) => url.pathname === "/volunteers");
  expect(new URL(page.url()).searchParams.get("q")).toBe("zz-no-such-member");
});

test("dev.volunteer is bounced from the old /volunteers/master URL too", async ({ page }) => {
  await devLogin(page, "dev.volunteer@yale.edu");
  await page.goto("/volunteers/master");
  // The redirect lands on /volunteers, whose guard then sends a viewer without
  // any roster permission away. Assert they end up on neither.
  await page.waitForURL((url) => url.pathname !== "/volunteers/master" && url.pathname !== "/volunteers");
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
  await page.goto("/volunteers/offboarding?tab=departments");
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

  // Arm the Flag button (first click). After this the button text changes to its
  // confirmLabel, "Flag this member for offboarding?".
  await memberRow.getByRole("button", { name: "Flag", exact: true }).click();

  // Now locate the armed row by person name (not by "Flag" button, which is gone).
  // The row still contains the person's name; find the armed button within it.
  const rowByName = itcmSection.locator("tr").filter({ hasText: personName }).first();
  await rowByName.getByRole("button").filter({ hasText: /\?/ }).first().click();

  // The flagged queue is its own tab now, so hop to it before looking for the row.
  await page.getByRole("link", { name: "Flagged", exact: true }).click();
  await page.waitForURL((url) => url.searchParams.get("tab") === "flagged");

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
// Per-person compliance view (dedicated clearance detail, not the admin record)
// ---------------------------------------------------------------------------

test("Jack opens a member's per-person compliance view and sees the clearance detail", async ({ page }) => {
  await devLogin(page, "j.carney@yale.edu");
  await page.goto(`/volunteers/compliance/${member.person.id}`);
  await page.waitForURL((url) => url.pathname === `/volunteers/compliance/${member.person.id}`);

  // The dedicated view (not /admin/people) offers the way back to the roster
  // as the breadcrumb. There is one roster now, at the module root, so the
  // crumb is "Volunteers" for everyone. The trail is applied after hydration,
  // so this waits on the crumb rather than asserting synchronously.
  const crumbs = page.locator('nav[aria-label="Breadcrumb"]');
  await expect(crumbs.getByRole("link", { name: "Volunteers", exact: true })).toHaveAttribute("href", "/volunteers");
  // ...and the leaf names the member, so two open tabs are told apart.
  await expect(crumbs.getByText(member.person.name)).toBeVisible();
  // And it is titled with the member's name.
  await expect(page.getByRole("heading", { name: member.person.name })).toBeVisible();
});

test("the roster links a member's name to their per-person compliance view", async ({ page }) => {
  await devLogin(page, "j.carney@yale.edu");
  await page.goto("/volunteers");
  await page.waitForURL((url) => url.pathname === "/volunteers");

  // Filter to the seeded member so their row is on the current page regardless of roster size.
  await page.getByPlaceholder("Name, NetID, or email…").fill(member.person.name);
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await page.waitForURL((url) => url.searchParams.get("q") !== null);

  const link = page.getByRole("link", { name: member.person.name });
  await expect(link).toHaveAttribute("href", `/volunteers/compliance/${member.person.id}`);
});
