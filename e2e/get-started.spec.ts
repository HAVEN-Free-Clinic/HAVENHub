import { expect, test } from "@playwright/test";
import { seedCourseWithPackage, seedUnclearedVolunteer } from "./fixtures";

/**
 * Onboarding gate: an uncleared volunteer cannot access the hub.
 *
 * Gate behavior (verified against the source):
 *   1. After dev login, NextAuth redirects to "/" (the default safeCallbackUrl).
 *   2. The hub page at "/" calls requirePersonSession() -> enforceOnboarding().
 *   3. enforceOnboarding sees that "/" is NOT on the onboarding allowlist and
 *      that the person is uncleared (profile incomplete: no phone; no HIPAA cert),
 *      so it fires redirect("/get-started").
 *
 * The test logs in inline (NOT using devLogin, which waits for pathname === "/"
 * and would hang because an uncleared user is never allowed to stay on "/").
 */
test("get-started gate: an uncleared volunteer is held at /get-started", async ({ page }) => {
  const v = await seedUnclearedVolunteer();
  try {
    // Inline login: navigate to /login, fill the dev-login form, submit.
    await page.goto("/login");
    await page.fill('input[name="email"]', v.person.contactEmail ?? "");
    await page.click('button:has-text("Dev sign in")');

    // The hub page (/) immediately redirects an uncleared user to /get-started
    // via enforceOnboarding inside requirePersonSession.
    await page.waitForURL((url) => url.pathname.startsWith("/get-started"), { timeout: 15_000 });

    // The get-started page renders its clearance checklist heading.
    await expect(page.getByRole("heading", { name: /get you cleared/i })).toBeVisible();

    // The gate must also fire on navigation to other gated routes.
    await page.goto("/my-info");
    await page.waitForURL((url) => url.pathname.startsWith("/get-started"), { timeout: 10_000 });
  } finally {
    await v?.cleanup();
  }
});

/**
 * The learning step must stay inside the locked onboarding flow. Before this
 * was fixed, /learning was on the onboarding allowlist, so the course player
 * rendered inside the full AppShell: an uncleared member saw every module tab,
 * and clicking one re-ran the gate and ejected them back to /get-started.
 */
test("get-started gate: the course player renders with no app nav, and /learning is closed", async ({ page }) => {
  // FOOD, not VADM: a department-scoped course is assigned to every member of
  // that department, and VADM is where the seeded dev users live.
  const v = await seedUnclearedVolunteer({ deptCode: "FOOD" });
  const c = await seedCourseWithPackage({ deptCode: "FOOD" });
  try {
    await page.goto("/login");
    await page.fill('input[name="email"]', v.person.contactEmail ?? "");
    await page.click('button:has-text("Dev sign in")');
    await page.waitForURL((url) => url.pathname.startsWith("/get-started"), { timeout: 15_000 });

    // Checklist to the course list to the course.
    await page.goto("/get-started/learning");
    await page.locator("a").filter({ hasText: c.course.title }).click();
    await page.waitForURL((url) => url.pathname.startsWith("/get-started/learning/"), { timeout: 10_000 });

    // The player is there.
    await expect(page.locator('iframe[title="Course content"]')).toBeVisible();
    // And none of the app chrome is.
    await expect(page.locator('nav[aria-label="Modules"]')).toHaveCount(0);
    await expect(page.locator('a[aria-label="Go to hub home"]')).toHaveCount(0);
    // The locked shell's own way back.
    await expect(page.getByRole("link", { name: "Back to courses" })).toBeVisible();

    // The old app route is now gated like every other hub page.
    await page.goto(`/learning/${c.course.id}`);
    await page.waitForURL((url) => url.pathname.startsWith("/get-started"), { timeout: 10_000 });
  } finally {
    await c?.cleanup();
    await v?.cleanup();
  }
});
