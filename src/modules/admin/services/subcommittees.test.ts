import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import {
  listSubcommittees, createSubcommittee, updateSubcommittee, getSubcommittee,
  SubcommitteeValidationError, SubcommitteeNotFoundError,
} from "./subcommittees";

async function actor() {
  return prisma.person.create({ data: { name: "Admin", status: "ACTIVE" } });
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

it("creates a subcommittee, defaults active, and lists it with a usage count", async () => {
  const a = await actor();
  const sc = await createSubcommittee(a.id, { name: "Community Outreach" });
  expect(sc.name).toBe("Community Outreach");
  expect(sc.isActive).toBe(true);
  const rows = await listSubcommittees();
  expect(rows).toHaveLength(1);
  expect(rows[0]._count.assignedApplications).toBe(0);
});

it("rejects a blank name", async () => {
  const a = await actor();
  await expect(createSubcommittee(a.id, { name: "   " })).rejects.toBeInstanceOf(SubcommitteeValidationError);
});

it("renames and deactivates (soft delete) an existing subcommittee", async () => {
  const a = await actor();
  const sc = await createSubcommittee(a.id, { name: "Old" });
  const updated = await updateSubcommittee(a.id, sc.id, { name: "New", isActive: false });
  expect(updated.name).toBe("New");
  expect(updated.isActive).toBe(false);
  expect(await getSubcommittee(sc.id)).not.toBeNull();
});

it("throws when updating a missing subcommittee", async () => {
  const a = await actor();
  await expect(updateSubcommittee(a.id, "missing", { name: "x", isActive: true }))
    .rejects.toBeInstanceOf(SubcommitteeNotFoundError);
});
