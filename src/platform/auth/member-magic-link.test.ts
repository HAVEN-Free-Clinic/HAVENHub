import { afterEach, beforeEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import {
  issueMemberToken,
  peekMemberToken,
  verifyAndConsumeMemberToken,
} from "./member-magic-link";

beforeEach(async () => {
  await resetDb();
});
afterEach(async () => {
  await resetDb();
});

async function seedMember(overrides: { contactEmail: string; status?: "ACTIVE" | "OFFBOARDED"; name?: string }) {
  return prisma.person.create({
    data: {
      name: overrides.name ?? "Casey Rivera",
      contactEmail: overrides.contactEmail,
      status: overrides.status ?? "ACTIVE",
    },
  });
}

it("issues a token that verifies once to the bound personId (single-use)", async () => {
  const person = await seedMember({ contactEmail: "casey@example.org" });
  const raw = await issueMemberToken(person.id, "casey@example.org");
  expect(await verifyAndConsumeMemberToken(raw)).toEqual({ personId: person.id });
  expect(await verifyAndConsumeMemberToken(raw)).toBeNull(); // single-use
});

it("peek reveals name + email without consuming the token", async () => {
  const person = await seedMember({ contactEmail: "casey@example.org", name: "Casey Rivera" });
  const raw = await issueMemberToken(person.id, "casey@example.org");
  expect(await peekMemberToken(raw)).toEqual({ email: "casey@example.org", name: "Casey Rivera" });
  // Still consumable afterwards:
  expect(await verifyAndConsumeMemberToken(raw)).toEqual({ personId: person.id });
});

it("rejects an expired token", async () => {
  const person = await seedMember({ contactEmail: "casey@example.org" });
  const raw = await issueMemberToken(person.id, "casey@example.org");
  const tokenHash = createHash("sha256").update(raw).digest("hex");
  await prisma.memberLoginToken.update({ where: { tokenHash }, data: { expiresAt: new Date(Date.now() - 1000) } });
  expect(await verifyAndConsumeMemberToken(raw)).toBeNull();
  expect(await peekMemberToken(raw)).toBeNull();
});

it("is single-use under concurrent verification (no TOCTOU)", async () => {
  const person = await seedMember({ contactEmail: "race@example.org" });
  const raw = await issueMemberToken(person.id, "race@example.org");
  const results = await Promise.all([verifyAndConsumeMemberToken(raw), verifyAndConsumeMemberToken(raw)]);
  const won = results.filter((r) => r !== null);
  expect(won).toEqual([{ personId: person.id }]);
});

it("rejects when the member has been offboarded after issue", async () => {
  const person = await seedMember({ contactEmail: "casey@example.org" });
  const raw = await issueMemberToken(person.id, "casey@example.org");
  await prisma.person.update({ where: { id: person.id }, data: { status: "OFFBOARDED" } });
  expect(await verifyAndConsumeMemberToken(raw)).toBeNull();
});

it("rejects when the member's contactEmail changed after issue", async () => {
  const person = await seedMember({ contactEmail: "casey@example.org" });
  const raw = await issueMemberToken(person.id, "casey@example.org");
  await prisma.person.update({ where: { id: person.id }, data: { contactEmail: "new@example.org" } });
  expect(await verifyAndConsumeMemberToken(raw)).toBeNull();
});
