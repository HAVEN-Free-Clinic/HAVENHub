import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";

// Mock Next.js server-only modules so the pure-crypto cookie tests run in Vitest.
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => ({ get: vi.fn(), set: vi.fn() })) }));
vi.mock("@/platform/auth/auth", () => ({ auth: vi.fn(async () => null) }));

import { issueMagicToken, verifyMagicToken, requestMagicLink } from "./portal-auth";
import { signApplicantCookie, readApplicantCookie, getApplicantIdentity, APPLICANT_COOKIE } from "./portal-auth";
import { auth } from "@/platform/auth/auth";
import { cookies } from "next/headers";

beforeEach(async () => { await resetDb(); });
afterEach(async () => {
  vi.clearAllMocks();
  await resetDb();
});

it("stores a portal token and finds it by hash", async () => {
  await prisma.applicantPortalToken.create({
    data: { emailLower: "a@yale.edu", tokenHash: "abc", expiresAt: new Date(Date.now() + 1000) },
  });
  const found = await prisma.applicantPortalToken.findUnique({ where: { tokenHash: "abc" } });
  expect(found?.emailLower).toBe("a@yale.edu");
  expect(found?.usedAt).toBeNull();
});

it("issues a token that verifies once and returns the email", async () => {
  const raw = await issueMagicToken("Reed@Yale.edu");
  expect(typeof raw).toBe("string");
  expect(await verifyMagicToken(raw)).toBe("reed@yale.edu"); // normalized
  expect(await verifyMagicToken(raw)).toBeNull(); // single-use
});

it("rejects an expired token", async () => {
  const raw = await issueMagicToken("x@yale.edu");
  // Expire it directly.
  const { createHash } = await import("node:crypto");
  const tokenHash = createHash("sha256").update(raw).digest("hex");
  await prisma.applicantPortalToken.update({ where: { tokenHash }, data: { expiresAt: new Date(Date.now() - 1000) } });
  expect(await verifyMagicToken(raw)).toBeNull();
});

it("rejects an unknown token", async () => {
  expect(await verifyMagicToken("not-a-real-token")).toBeNull();
});

it("is single-use under concurrent verification (no TOCTOU)", async () => {
  const raw = await issueMagicToken("race@yale.edu");
  const results = await Promise.all([verifyMagicToken(raw), verifyMagicToken(raw)]);
  const succeeded = results.filter((r) => r !== null);
  expect(succeeded).toEqual(["race@yale.edu"]); // exactly one wins, the other is null
});

it("signs and reads back a cookie email, rejecting tampering", () => {
  const cookie = signApplicantCookie("Reed@Yale.edu");
  expect(readApplicantCookie(cookie)).toBe("reed@yale.edu");
  expect(readApplicantCookie(cookie + "x")).toBeNull(); // tampered signature
  expect(readApplicantCookie(undefined)).toBeNull();
  expect(readApplicantCookie("garbage")).toBeNull();
});

it("queues a magic-link email containing a verify URL and rate-limits", async () => {
  await requestMagicLink("reed@yale.edu");
  const emails = await prisma.emailLog.findMany();
  expect(emails).toHaveLength(1);
  expect(emails[0].toEmail).toBe("reed@yale.edu");
  expect(emails[0].template).toBe("recruitment.portal_link");
  expect(emails[0].html).toContain("/apply/verify?token=");

  // Rate limit: three more requests do not all send.
  await requestMagicLink("reed@yale.edu");
  await requestMagicLink("reed@yale.edu");
  await requestMagicLink("reed@yale.edu");
  const after = await prisma.emailLog.count();
  expect(after).toBeLessThanOrEqual(3); // capped, not 4+
});

// ---------------------------------------------------------------------------
// getApplicantIdentity: SSO session wins, cookie-only path, neither -> null
// ---------------------------------------------------------------------------

it("getApplicantIdentity returns the SSO session identity when a Person session exists", async () => {
  vi.mocked(auth).mockResolvedValueOnce({ personId: "p1", user: { email: "Member@Yale.edu" } } as never);
  // cookies() is not called on the SSO path (early return); no need to queue a value.
  expect(await getApplicantIdentity()).toEqual({ email: "member@yale.edu", personId: "p1" });
});

it("getApplicantIdentity falls back to the signed cookie when there is no SSO session", async () => {
  vi.mocked(auth).mockResolvedValueOnce(null as never);
  vi.mocked(cookies).mockResolvedValueOnce({
    get: (n: string) => (n === APPLICANT_COOKIE ? { value: signApplicantCookie("guest@yale.edu") } : undefined),
  } as never);
  expect(await getApplicantIdentity()).toEqual({ email: "guest@yale.edu", personId: null });
});

it("getApplicantIdentity returns null when there is neither a session nor a valid cookie", async () => {
  vi.mocked(auth).mockResolvedValueOnce(null as never);
  vi.mocked(cookies).mockResolvedValueOnce({ get: () => undefined } as never);
  expect(await getApplicantIdentity()).toBeNull();
});
