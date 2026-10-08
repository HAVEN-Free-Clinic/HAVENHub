import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { createTraining } from "./trainings";
import { markEhsComplete } from "./completion";
import {
  grantProvisionalClearance,
  revokeProvisionalClearance,
  PROVISIONAL_PERMISSION,
  ProvisionalForbiddenError,
  ProvisionalInvalidError,
} from "./provisional";

beforeEach(resetDb);
afterEach(resetDb);

const DAY = 24 * 60 * 60 * 1000;
const inDays = (n: number) => new Date(Date.now() + n * DAY);

async function setup({ admin = true }: { admin?: boolean } = {}) {
  const actor = await prisma.person.create({ data: { name: "Admin", status: "ACTIVE" } });
  const person = await prisma.person.create({ data: { name: "Juan", status: "ACTIVE" } });
  const training = await createTraining({ name: "TB Screening", requiredForAll: true }, actor.id);
  if (admin) {
    const role = await prisma.role.create({
      data: { name: "Test admin", grants: { create: [{ permission: PROVISIONAL_PERMISSION }] } },
    });
    await prisma.roleAssignment.create({ data: { roleId: role.id, personId: actor.id, termId: null } });
  }
  return { actor, person, training };
}

const input = (personId: string, trainingId: string, expiresAt: Date, reason = "TB test taken 10/7") => ({
  personId,
  trainingId,
  expiresAt,
  reason,
});

describe("grantProvisionalClearance", () => {
  it("refuses anyone without the permission", async () => {
    const { actor, person, training } = await setup({ admin: false });
    await expect(
      grantProvisionalClearance(actor.id, input(person.id, training.id, inDays(7))),
    ).rejects.toBeInstanceOf(ProvisionalForbiddenError);
    expect(await prisma.ehsProvisionalClearance.count()).toBe(0);
  });

  it("creates a live grant with the reason trimmed", async () => {
    const { actor, person, training } = await setup();
    const grant = await grantProvisionalClearance(
      actor.id,
      input(person.id, training.id, inDays(7), "  TB test taken 10/7  "),
    );
    expect(grant.reason).toBe("TB test taken 10/7");
    expect(grant.grantedById).toBe(actor.id);
    expect(grant.revokedAt).toBeNull();
  });

  it("refuses an end date in the past", async () => {
    const { actor, person, training } = await setup();
    await expect(
      grantProvisionalClearance(actor.id, input(person.id, training.id, inDays(-1))),
    ).rejects.toBeInstanceOf(ProvisionalInvalidError);
  });

  it("refuses an end date more than 30 days out", async () => {
    const { actor, person, training } = await setup();
    await expect(
      grantProvisionalClearance(actor.id, input(person.id, training.id, inDays(31))),
    ).rejects.toBeInstanceOf(ProvisionalInvalidError);
  });

  it("refuses a blank reason", async () => {
    const { actor, person, training } = await setup();
    await expect(
      grantProvisionalClearance(actor.id, input(person.id, training.id, inDays(7), "   ")),
    ).rejects.toBeInstanceOf(ProvisionalInvalidError);
  });

  it("refuses an item that is already complete", async () => {
    const { actor, person, training } = await setup();
    await markEhsComplete(person.id, training.id, actor.id);
    await expect(
      grantProvisionalClearance(actor.id, input(person.id, training.id, inDays(7))),
    ).rejects.toBeInstanceOf(ProvisionalInvalidError);
  });

  it("replaces an existing live grant, so only one counts", async () => {
    const { actor, person, training } = await setup();
    const first = await grantProvisionalClearance(actor.id, input(person.id, training.id, inDays(3)));
    const second = await grantProvisionalClearance(actor.id, input(person.id, training.id, inDays(10)));

    const live = await prisma.ehsProvisionalClearance.findMany({
      where: { personId: person.id, revokedAt: null },
    });
    expect(live.map((g) => g.id)).toEqual([second.id]);
    const old = await prisma.ehsProvisionalClearance.findUnique({ where: { id: first.id } });
    expect(old!.revokedById).toBe(actor.id);
  });
});

describe("revokeProvisionalClearance", () => {
  it("ends a live grant, and refuses to end it twice", async () => {
    const { actor, person, training } = await setup();
    const grant = await grantProvisionalClearance(actor.id, input(person.id, training.id, inDays(7)));

    await revokeProvisionalClearance(actor.id, grant.id);
    const after = await prisma.ehsProvisionalClearance.findUnique({ where: { id: grant.id } });
    expect(after!.revokedAt).not.toBeNull();

    await expect(revokeProvisionalClearance(actor.id, grant.id)).rejects.toBeInstanceOf(
      ProvisionalInvalidError,
    );
  });

  it("refuses anyone without the permission", async () => {
    const { actor, person, training } = await setup();
    const grant = await grantProvisionalClearance(actor.id, input(person.id, training.id, inDays(7)));
    const outsider = await prisma.person.create({ data: { name: "Outsider", status: "ACTIVE" } });

    await expect(revokeProvisionalClearance(outsider.id, grant.id)).rejects.toBeInstanceOf(
      ProvisionalForbiddenError,
    );
  });
});