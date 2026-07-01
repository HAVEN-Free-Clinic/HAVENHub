import { expect, test } from "@playwright/test";
import { seedUnclearedVolunteer } from "./fixtures";

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
