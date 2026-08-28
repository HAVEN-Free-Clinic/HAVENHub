import { expect, test } from "@playwright/test";
import { seedHistoricalApplicant, tag } from "./fixtures";

async function devSignIn(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', "j.carney@yale.edu");
  await page.click('button:has-text("Dev sign in")');
  await page.waitForURL((url) => url.pathname === "/");
}

// The trigger's accessible name is "Search the hub", not a bare "Search":
// several pages (e.g. /admin/people) have their own filter-submit button
// named exactly "Search", and a bare name here collided with those in CI
// (fix round 1). The palette's dialog keeps aria-label="Search" -- role
// "dialog" can never collide with a role "button" lookup, so it did not need
// the same treatment. exact:true on top of the distinct name is belt and
// suspenders: as in e2e/global-nav.spec.ts, every lookup here is role-scoped
// rather than text-scoped, since Playwright strict mode throws the moment a
// selector matches more than one element.
function trigger(page: import("@playwright/test").Page) {
  return page.getByRole("button", { name: "Search the hub", exact: true });
}

function dialog(page: import("@playwright/test").Page) {
  return page.getByRole("dialog", { name: "Search" });
}

function combobox(page: import("@playwright/test").Page) {
  return page.getByRole("combobox", { name: "Search pages, people, cycles, past applicants, and requests" });
}

/**
 * Block until the palette's client handlers are actually live.
 *
 * The trigger is server-rendered, so `toBeVisible()` on it proves only that
 * HTML arrived -- not that React has hydrated and attached the document-level
 * keydown listener the shortcut needs. That gap is a real race, and waiting on
 * the trigger (fix rounds 1 and 2) never closed it: CI failed here again on
 * 2026-08-28, and it reproduces locally on a cold dev server.
 *
 * Opening via the trigger's own onClick is the barrier, because that handler
 * is `setOpen(true)` -- idempotent, so `toPass` can retry the click until
 * hydration lands without ever toggling the dialog back closed. The shortcut
 * itself is `setOpen(v => !v)`, so retrying THAT would oscillate; it must not
 * be used as the probe. Escape then returns us to a closed palette so the
 * caller starts from a clean state.
 */
async function waitForPaletteReady(page: import("@playwright/test").Page) {
  await expect(trigger(page)).toBeVisible();
  await expect(async () => {
    await trigger(page).click();
    await expect(dialog(page)).toBeVisible({ timeout: 500 });
  }).toPass({ timeout: 15_000 });
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
}

test("Control+K opens the palette from an arbitrary page", async ({ page }) => {
  // Playwright runs Chromium on Linux in CI, where Control+K (not Meta+K) is
  // the shortcut that actually fires; the palette's own handler listens for
  // either modifier.
  await devSignIn(page);
  await page.goto("/schedule");
  await waitForPaletteReady(page);
  await page.keyboard.press("Control+k");
  await expect(dialog(page)).toBeVisible();
  await expect(combobox(page)).toBeFocused();
});

test("the visible Search trigger opens the palette too", async ({ page }) => {
  await devSignIn(page);
  await trigger(page).click();
  await expect(dialog(page)).toBeVisible();
});

test("typing a page name and pressing Enter navigates there", async ({ page }) => {
  await devSignIn(page);
  await page.goto("/schedule");
  await trigger(page).click();
  await combobox(page).fill("Volunteers");
  await page.keyboard.press("Enter");
  await page.waitForURL((url) => url.pathname === "/volunteers");
  await expect(page).toHaveURL(/\/volunteers$/);
});

test("Escape closes the palette and returns focus to the trigger", async ({ page }) => {
  await devSignIn(page);
  await trigger(page).click();
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await expect(trigger(page)).toBeFocused();
});

test("pressing the shortcut again while open closes the palette and restores focus to the trigger", async ({
  page,
}) => {
  // This toggle-closed path (the shortcut fired again while the dialog is
  // already open) was added in a fix round after the palette first shipped
  // and has had no coverage at all until now. It only works because the
  // global keydown handler's typing-target guard special-cases the palette's
  // own input, which stays focused the whole time the dialog is open: without
  // that carve-out, the second Control+K would be swallowed as "the user is
  // typing somewhere" and never reach the toggle.
  await devSignIn(page);
  await waitForPaletteReady(page);
  await page.keyboard.press("Control+k");
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press("Control+k");
  await expect(dialog(page)).toHaveCount(0);
  await expect(trigger(page)).toBeFocused();
});

test("searching an admin's own name surfaces a People result that opens without hitting /no-access", async ({
  page,
}) => {
  // The dev sign-in identity (j.carney@yale.edu) seeds as "Jack Carney", a
  // Platform Admin holding the `*` wildcard, so this viewer holds
  // admin.manage_people and gets People results, and every href searchEntities
  // hands back for them (/admin/people/<id>) is a page they can actually open.
  await devSignIn(page);
  await trigger(page).click();
  await combobox(page).fill("Jack Carney");
  const peopleGroup = page.getByRole("group", { name: "People" });
  const result = peopleGroup.getByRole("option", { name: "Jack Carney", exact: true });
  await expect(result).toBeVisible();
  await result.click();
  await page.waitForURL((url) => url.pathname.startsWith("/admin/people/"));
  await expect(page).not.toHaveURL(/\/no-access/);
});

test("searching a past applicant's name surfaces a Recruitment history result that opens without hitting /no-access", async ({
  page,
}) => {
  // The group exists for exactly this person: someone who applied years ago and
  // never joined has no Person row, so the People query can never return them
  // however the viewer spells the name. Seeded rather than assumed, because the
  // suite runs serially against a shared, never-emptied database and this
  // environment's imported history may be empty.
  const t = tag();
  const email = `palette-history-${t}@example.test`;
  const lastName = `Palette ${t}`;
  const fullName = `E2eHistory ${lastName}`;
  const { applicant, cleanup } = await seedHistoricalApplicant({ email, firstName: "E2eHistory", lastName });

  try {
    await devSignIn(page);
    await trigger(page).click();
    await combobox(page).fill(fullName);
    const historyGroup = page.getByRole("group", { name: "Recruitment history" });
    // Not exact, unlike the People lookup above: a history row renders its
    // sub-line (the NetID, or the email when there is none) inside the option
    // itself, so the option's accessible name is the label AND that sub-line.
    // The tag in the surname is unique, so a substring match is unambiguous.
    const result = historyGroup.getByRole("option", { name: fullName });
    await expect(result).toBeVisible();
    // The sub-line is the point of that looser matcher, so pin it: this row has
    // no NetID, so it must fall back to the email.
    await expect(result).toContainText(email);
    await result.click();
    // The href must land, not bounce: /recruitment/history/[id] requires
    // recruitment.access outright, which is the same gate the search applies.
    await page.waitForURL((url) => url.pathname === `/recruitment/history/${applicant.id}`);
    await expect(page).not.toHaveURL(/\/no-access/);
    await expect(page.getByRole("heading", { name: fullName, level: 1 })).toBeVisible();
  } finally {
    await cleanup();
  }
});

test("the palette still opens and shows page results when /api/search is failing", async ({ page }) => {
  // Mirrors the notifications inbox's degraded path (#327/#340): a Neon blip
  // must not turn the palette into a dead or broken control. Page results are
  // resolved entirely client-side from the nav's own permission-filtered data
  // (see matchPages), so they must keep rendering even while the entity
  // endpoint is returning 503s.
  await devSignIn(page);
  await page.route("**/api/search**", (route) =>
    route.fulfill({ status: 503, body: JSON.stringify({ error: "Search unavailable" }) }),
  );
  await trigger(page).click();
  const failedSearch = page.waitForResponse(
    (res) => res.url().includes("/api/search") && res.status() === 503,
  );
  await combobox(page).fill("Schedule");
  await failedSearch;
  await expect(page.getByRole("option", { name: "Schedule", exact: true })).toBeVisible();
  await expect(page.getByText("Search unavailable")).toHaveCount(0);
});
