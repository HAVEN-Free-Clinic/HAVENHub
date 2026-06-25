import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";

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
