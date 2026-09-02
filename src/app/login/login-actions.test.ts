import { afterEach, expect, it, vi } from "vitest";

// login-actions imports auth, next-auth and next/navigation at top level; mock
// them so the module imports cleanly in the node test env. The member magic-link
// path is exercised through its own service tests, so stand its dependencies out.
vi.mock("@/platform/auth/auth", () => ({ signIn: vi.fn(async () => {}) }));
// Importing the real next-auth in the node test env fails resolving next/server,
// so stand in a minimal AuthError. The action imports AuthError from this same
// specifier, so `instanceof` stays coherent against the class constructed here.
vi.mock("next-auth", () => ({ AuthError: class AuthError extends Error {} }));
vi.mock("@/platform/auth/member-magic-link", () => ({ requestMemberLoginLink: vi.fn() }));
vi.mock("@/platform/posthog/capture", () => ({ captureEvent: vi.fn() }));
// redirect() throws in production, which is what stops the action falling through
// to its rethrow. Model that: throw a tagged sentinel carrying the target URL.
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

afterEach(() => vi.clearAllMocks());

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

it("passes a safe same-origin callbackUrl to signIn as the post-auth destination", async () => {
  await signInWithYaleAction(form({ callbackUrl: "/schedule" }));

  expect(signIn).toHaveBeenCalledWith("microsoft-entra-id", { redirectTo: "/schedule" });
});

it("collapses a hostile callbackUrl to the home page before it reaches signIn", async () => {
  await signInWithYaleAction(form({ callbackUrl: "//evil.com" }));

  expect(signIn).toHaveBeenCalledWith("microsoft-entra-id", { redirectTo: "/" });
});

it("defaults to the home page when the form carries no callbackUrl", async () => {
  await signInWithYaleAction(new FormData());

  expect(signIn).toHaveBeenCalledWith("microsoft-entra-id", { redirectTo: "/" });
});

it("returns a failed Yale sign-in to /login with the error type and destination", async () => {
  vi.mocked(signIn).mockRejectedValueOnce(Object.assign(new AuthError("nope"), { type: "CredentialsSignin" }));

  await expect(signInWithYaleAction(form({ callbackUrl: "/schedule" }))).rejects.toThrow(
    `redirect:/login?error=CredentialsSignin&callbackUrl=${encodeURIComponent("/schedule")}`,
  );
});

// The load-bearing test. signIn() signals SUCCESS by throwing NEXT_REDIRECT, so a
// bare `catch` would swallow the redirect and leave the member on a page that
// silently did nothing. Only this test fails against that bug. Do not delete it.
it("lets a non-AuthError throw propagate so the OAuth redirect is never swallowed", async () => {
  const nextRedirect = new Error("NEXT_REDIRECT");
  vi.mocked(signIn).mockRejectedValueOnce(nextRedirect);

  await expect(signInWithYaleAction(new FormData())).rejects.toBe(nextRedirect);
});
