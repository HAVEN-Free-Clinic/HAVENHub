/**
 * Cover for the Yale SSO server action -- the front door for nearly everyone.
 *
 * What is worth pinning here is not the happy path but the two ways this button
 * can go quietly wrong: swallowing the OAuth redirect (leaving a member on a
 * button that does nothing), and trusting a `callbackUrl` that now arrives in
 * the form body rather than in a closure.
 */
import { expect, it, vi, afterEach } from "vitest";

// The action module pulls in next/headers and auth at import time; mock them so
// it loads in the node test env.
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: vi.fn(), set: vi.fn(), delete: vi.fn() })),
  headers: vi.fn(async () => ({ get: vi.fn(() => null) })),
}));
vi.mock("@/platform/auth/auth", () => ({
  signIn: vi.fn(async () => {}),
  signOut: vi.fn(async () => {}),
  auth: vi.fn(async () => null),
}));
// Importing the real next-auth in the node test env fails resolving next/server,
// so stand in a minimal AuthError. The action imports AuthError from this same
// specifier, so `instanceof` stays coherent against the class constructed here.
//
// It carries `type` because the real one does, and because that is what the
// action puts in the query string for /login's ERROR_MESSAGES to look up. A
// stub without it passes this file while shipping `?error=undefined`.
vi.mock("next-auth", () => ({
  AuthError: class AuthError extends Error {
    type: string;
    constructor(type: string) {
      super(type);
      this.type = type;
    }
  },
}));
// redirect() throws in production, which is what stops the action falling
// through to its rethrow. Model that with a tagged sentinel carrying the URL.
class RedirectSentinel extends Error {
  constructor(readonly url: string) {
    super(`redirect:${url}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new RedirectSentinel(url);
  }),
}));

import { AuthError } from "next-auth";
import { signIn } from "@/platform/auth/auth";
import { signInWithYaleAction } from "./login-actions";

afterEach(() => {
  vi.clearAllMocks();
});

function formWith(callbackUrl?: string): FormData {
  const fd = new FormData();
  if (callbackUrl !== undefined) fd.set("callbackUrl", callbackUrl);
  return fd;
}

it("forwards a safe callback to signIn as the post-auth destination", async () => {
  await signInWithYaleAction(formWith("/volunteers/master"));

  expect(signIn).toHaveBeenCalledWith("microsoft-entra-id", {
    redirectTo: "/volunteers/master",
  });
});

it("collapses a hostile callback to the home page before it reaches signIn", async () => {
  // The destination is a hidden field on a public, unauthenticated page now, so
  // it is attacker-controlled input and must be re-sanitised server-side rather
  // than trusted because the page rendered it.
  for (const hostile of ["//evil.com", "/\\evil.com", "https://evil.com/x"]) {
    await signInWithYaleAction(formWith(hostile));
    expect(signIn).toHaveBeenLastCalledWith("microsoft-entra-id", { redirectTo: "/" });
  }
});

it("defaults to the home page when the form carries no callback", async () => {
  await signInWithYaleAction(formWith());

  expect(signIn).toHaveBeenCalledWith("microsoft-entra-id", { redirectTo: "/" });
});

it("returns a failed sign-in to /login with the error and the callback intact", async () => {
  vi.mocked(signIn).mockRejectedValueOnce(new AuthError("OAuthSignInError"));

  await expect(signInWithYaleAction(formWith("/volunteers/master"))).rejects.toThrow(
    `redirect:/login?error=OAuthSignInError&callbackUrl=${encodeURIComponent("/volunteers/master")}`,
  );
});

/**
 * The load-bearing test. signIn() signals SUCCESS by throwing NEXT_REDIRECT, so
 * a bare `catch` would swallow the redirect and strand the member on a button
 * that appears to do nothing. Every test above still passes against that bug;
 * only this one fails. Do not delete it.
 */
it("lets a non-AuthError throw propagate so the OAuth redirect is never swallowed", async () => {
  const nextRedirect = new Error("NEXT_REDIRECT");
  vi.mocked(signIn).mockRejectedValueOnce(nextRedirect);

  await expect(signInWithYaleAction(formWith())).rejects.toBe(nextRedirect);
});
