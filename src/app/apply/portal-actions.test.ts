import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";

// The server action module imports next/headers + auth at top level; mock them
// so it imports cleanly in the node test env (the cookie/signOut paths are
// exercised elsewhere).
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => ({ get: vi.fn(), set: vi.fn(), delete: vi.fn() })), headers: vi.fn(async () => ({ get: vi.fn(() => null) })) }));
vi.mock("@/platform/auth/auth", () => ({ signOut: vi.fn(async () => {}), auth: vi.fn(async () => null), signIn: vi.fn(async () => {}) }));
// Importing the real next-auth in the node test env fails resolving next/server,
// so stand in a minimal AuthError. The action imports AuthError from this same
// specifier, so `instanceof` stays coherent against the class constructed here.
vi.mock("next-auth", () => ({ AuthError: class AuthError extends Error {} }));
// redirect() throws in production, which is what stops the action falling through
// to its rethrow. Model that: throw a tagged sentinel carrying the target URL.
class RedirectSentinel extends Error {
  constructor(readonly url: string) { super(`redirect:${url}`); }
}
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => { throw new RedirectSentinel(url); }),
}));

import { AuthError } from "next-auth";
import { signIn } from "@/platform/auth/auth";
import { requestMagicLinkAction, portalYaleSignInAction } from "./portal-actions";

beforeEach(async () => { await resetDb(); });
afterEach(async () => { vi.clearAllMocks(); await resetDb(); });

it("forwards a deep-link next from the sign-in form into the magic-link email", async () => {
  const fd = new FormData();
  fd.set("email", "reed@yale.edu");
  fd.set("next", "/apply/spring-2026");

  const res = await requestMagicLinkAction(fd);
  expect(res.ok).toBe(true);

  const mail = await prisma.emailLog.findFirstOrThrow({ where: { template: "recruitment.portal_link" } });
  expect(mail.html).toContain(`next=${encodeURIComponent("/apply/spring-2026")}`);
});

it("sends a clean link when the form carries no next", async () => {
  const fd = new FormData();
  fd.set("email", "reed@yale.edu");

  const res = await requestMagicLinkAction(fd);
  expect(res.ok).toBe(true);

  const mail = await prisma.emailLog.findFirstOrThrow({ where: { template: "recruitment.portal_link" } });
  expect(mail.html).not.toContain("next=");
});

it("passes a safe deep-link next to signIn as the post-auth destination", async () => {
  const fd = new FormData();
  fd.set("next", "/apply/spring-2026");

  await portalYaleSignInAction(fd);

  expect(signIn).toHaveBeenCalledWith("microsoft-entra-id", { redirectTo: "/apply/spring-2026" });
});

it("collapses a hostile next to the portal home before it reaches signIn", async () => {
  const fd = new FormData();
  fd.set("next", "//evil.com");

  await portalYaleSignInAction(fd);

  expect(signIn).toHaveBeenCalledWith("microsoft-entra-id", { redirectTo: "/apply" });
});

it("defaults to the portal home when the form carries no next", async () => {
  await portalYaleSignInAction(new FormData());

  expect(signIn).toHaveBeenCalledWith("microsoft-entra-id", { redirectTo: "/apply" });
});

it("returns a failed Yale sign-in to the portal, not to the hub login page", async () => {
  vi.mocked(signIn).mockRejectedValueOnce(new AuthError("nope"));
  const fd = new FormData();
  fd.set("next", "/apply/spring-2026");

  await expect(portalYaleSignInAction(fd)).rejects.toThrow(
    `redirect:/apply?error=signin&next=${encodeURIComponent("/apply/spring-2026")}`,
  );
});

it("omits the next param when the failure had no deep link to preserve", async () => {
  vi.mocked(signIn).mockRejectedValueOnce(new AuthError("nope"));

  await expect(portalYaleSignInAction(new FormData())).rejects.toThrow("redirect:/apply?error=signin");
});

// The load-bearing test. signIn() signals SUCCESS by throwing NEXT_REDIRECT, so a
// bare `catch` would swallow the redirect and leave the applicant on a page that
// silently did nothing. Every test above still passes against that bug; only this
// one fails. Do not delete it.
it("lets a non-AuthError throw propagate so the OAuth redirect is never swallowed", async () => {
  const nextRedirect = new Error("NEXT_REDIRECT");
  vi.mocked(signIn).mockRejectedValueOnce(nextRedirect);

  await expect(portalYaleSignInAction(new FormData())).rejects.toBe(nextRedirect);
});
