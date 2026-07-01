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
import { setSetting } from "@/platform/settings/service";

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

it("builds the magic link from the configurable app.baseUrl setting, not the raw env default", async () => {
  // Admin has set the public base URL (e.g. the custom domain) in settings.
  // Every other outbound-email link honors this; the magic link must too.
  await setSetting("app.baseUrl", "https://hub.havenfreeclinic.org", null);

  await requestMagicLink("applicant@yale.edu");

  const mail = await prisma.emailLog.findFirstOrThrow({ where: { template: "recruitment.portal_link" } });
  expect(mail.html).toContain("https://hub.havenfreeclinic.org/apply/verify?token=");
  // It must not fall back to the deploy-time env default for the verify link.
  expect(mail.html).not.toContain("http://localhost:3000/apply/verify");
});

it("threads a safe deep-link next into the magic-link verify URL", async () => {
  // An applicant who started /apply/<slug> while signed out should land back on
  // that form after clicking the emailed link, so the verify URL must carry next.
  await requestMagicLink("reed@yale.edu", "/apply/spring-2026?type=renewal");

  const mail = await prisma.emailLog.findFirstOrThrow({ where: { template: "recruitment.portal_link" } });
  expect(mail.html).toContain("/apply/verify?token=");
  expect(mail.html).toContain(`next=${encodeURIComponent("/apply/spring-2026?type=renewal")}`);
});

it("strips an unsafe next from the magic-link verify URL (no open redirect)", async () => {
  await requestMagicLink("reed@yale.edu", "//evil.com");

  const mail = await prisma.emailLog.findFirstOrThrow({ where: { template: "recruitment.portal_link" } });
  expect(mail.html).not.toContain("evil.com");
  expect(mail.html).not.toContain("next=");
});

it("omits next entirely when no deep-link target is given", async () => {
  await requestMagicLink("reed@yale.edu");

  const mail = await prisma.emailLog.findFirstOrThrow({ where: { template: "recruitment.portal_link" } });
  expect(mail.html).toContain("/apply/verify?token=");
  expect(mail.html).not.toContain("next=");
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

it("queues a magic link rendered through the global template + layout", async () => {
  await requestMagicLink("someone@yale.edu");
  const mail = await prisma.emailLog.findFirstOrThrow({ where: { template: "recruitment.portal_link" } });
  expect(mail.subject).toBe("Your HAVEN Hub application link");
  expect(mail.html).toContain("Open my application");
  expect(mail.html).toContain("<!DOCTYPE html>");
});
