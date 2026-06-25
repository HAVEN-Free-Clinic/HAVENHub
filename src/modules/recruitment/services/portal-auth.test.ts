import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";

// Mock Next.js server-only modules so the pure-crypto cookie tests run in Vitest.
vi.mock("next/headers", () => ({ cookies: async () => ({ get: vi.fn(), set: vi.fn() }) }));
vi.mock("@/platform/auth/auth", () => ({ auth: async () => null }));

import { issueMagicToken, verifyMagicToken } from "./portal-auth";
import { signApplicantCookie, readApplicantCookie } from "./portal-auth";

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

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
