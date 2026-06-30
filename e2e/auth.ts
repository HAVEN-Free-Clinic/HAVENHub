import type { Page } from "@playwright/test";

const ROLE_EMAILS = {
  admin: "j.carney@yale.edu",
  director: "dev.director@yale.edu",
  volunteer: "dev.volunteer@yale.edu",
} as const;

export type Role = keyof typeof ROLE_EMAILS;

/** Email-only dev login. Lands on the hub root. */
export async function devLogin(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.fill('input[name="email"]', email);
  await page.click('button:has-text("Dev sign in")');
  await page.waitForURL((url) => url.pathname === "/");
}

/** Convenience: log in as one of the three seeded identities. */
export function loginAs(page: Page, role: Role): Promise<void> {
  return devLogin(page, ROLE_EMAILS[role]);
}
