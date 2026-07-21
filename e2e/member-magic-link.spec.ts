import { expect, test } from "@playwright/test";
import { prisma, seedActiveMember } from "./fixtures";

/**
 * End-to-end member magic-link sign-in: a non-Yale ACTIVE member requests a
 * one-time link from the "Not a Yale affiliate?" form on /login, the app
 * queues it as an auth.member_login_link EmailLog row, and following the
 * emailed /login/verify link through the peek-then-confirm screen mints a
 * real personId session (requestMemberLoginLink + peekMemberToken +
 * signIn("member-magic-link") in src/platform/auth/member-magic-link.ts and
 * src/app/login/verify/page.tsx).
 *
 * The raw token is never persisted (issueMemberToken stores only its SHA-256
 * hash), so the only way to recover it here is the way a real recipient
 * would: parsed out of the queued email's HTML body.
 *
 * /login renders two inputs labeled "Email" (this member form, and the
 * "Local development" dev-credentials form below it), so the member field is
 * targeted by its unique id (#member-email) rather than getByLabel, which
 * would violate Playwright's strict mode.
 */
test("non-Yale active member signs in via emailed link", async ({ page }) => {
  const { person, cleanup } = await seedActiveMember();
  const email = person.contactEmail!;
  try {
    // --- Request the link from the non-Yale member form ---
    await page.goto("/login");
    await page.locator("#member-email").fill(email);
    await page.getByRole("button", { name: /Email me a sign-in link/i }).click();
    await expect(page.getByText(/we have sent a sign-in link/i)).toBeVisible();

    // --- Recover the raw token from the queued email, same as a real recipient ---
    const log = await prisma.emailLog.findFirstOrThrow({
      where: { template: "auth.member_login_link", toEmail: email },
      orderBy: { createdAt: "desc" },
    });
    const match = /\/login\/verify\?token=[^"'&]+/.exec(log.html);
    expect(match).toBeTruthy();
    const verifyPath = match![0];

    // --- Visit the verify link: peek-then-confirm shows who it's for first ---
    await page.goto(verifyPath);
    await expect(page.getByRole("heading", { name: "Confirm sign-in" })).toBeVisible();
    await expect(page.getByText(email)).toBeVisible();
    await page.getByRole("button", { name: /Continue/i }).click();

    // --- Confirming lands a real session. Neither /login (not signed in) nor
    // /welcome (signed in with no personId) is reachable with one; landing
    // anywhere else -- the hub root or /get-started, depending on onboarding
    // clearance -- proves the session carries this member's personId. ---
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page).not.toHaveURL(/\/welcome/);
  } finally {
    await cleanup();
  }
});

test("a @yale.edu address is told to use Yale sign-in and queues no member link email", async ({
  page,
}) => {
  const email = `e2e-yale-${Date.now()}@yale.edu`;
  await page.goto("/login");
  await page.locator("#member-email").fill(email);
  await page.getByRole("button", { name: /Email me a sign-in link/i }).click();
  // Exact copy is `Use "Sign in with Yale" above.`; matching on "That is a Yale
  // email" avoids ambiguity with the separate "Sign in with Yale" OAuth button
  // that renders elsewhere on the page when Entra ID is configured.
  await expect(page.getByText(/That is a Yale email/i)).toBeVisible();
  expect(
    await prisma.emailLog.count({
      where: { template: "auth.member_login_link", toEmail: email },
    })
  ).toBe(0);
});
