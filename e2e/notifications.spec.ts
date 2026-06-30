import { expect, test } from "@playwright/test";
import { loginAs } from "./auth";
import { prisma, seedNotification } from "./fixtures";

test("notifications: bell badge + inbox row, then mark read", async ({ page }) => {
  const admin = await prisma.person.findUniqueOrThrow({
    where: { contactEmail: "j.carney@yale.edu" },
  });
  const notif = await seedNotification(admin.id, { title: "E2E unread notice" });
  try {
    await loginAs(page, "admin");

    // The bell fetches unread count asynchronously on mount. Assert its aria-label
    // contains "unread" confirming count >= 1 without pinning an exact number (the
    // rich local DB may already have other unread notifications; the bare CI seed
    // will also have exactly 1 from our seed).
    await expect(
      page.getByRole("button", { name: /notifications.*unread/i })
    ).toBeVisible({ timeout: 10_000 });

    // Navigate to the full inbox.
    await page.goto("/notifications");

    // The seeded notification must appear in the list.
    const notifRow = page
      .locator('button[type="submit"]')
      .filter({ hasText: "E2E unread notice" });
    await expect(notifRow).toBeVisible();

    // Confirm the unread dot (bg-brand) is rendered on this specific row before
    // marking it read. This rules out a false-positive on the post-read check.
    await expect(notifRow.locator(".bg-brand")).toBeVisible();

    // Click the row: the openAction server action calls markRead then redirects
    // back to /notifications. We wait for the navigation to settle.
    await notifRow.click();
    await page.waitForLoadState("networkidle");

    // Scope the post-read assertion to the seeded row only. The unread dot should
    // no longer be rendered because readAt is now set. Asserting on THIS specific
    // row (not on a total unread count) makes the test robust on both the rich
    // local DB (other unread rows still present) and the bare CI seed (no others).
    const readRow = page
      .locator('button[type="submit"]')
      .filter({ hasText: "E2E unread notice" });
    await expect(readRow).toBeVisible();
    await expect(readRow.locator(".bg-brand")).not.toBeVisible();
  } finally {
    await notif.cleanup();
  }
});
