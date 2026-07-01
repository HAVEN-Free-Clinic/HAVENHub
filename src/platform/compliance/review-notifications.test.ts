import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { notifyDatelessCertReview } from "./review-notifications";

beforeEach(resetDb);

/** A person who globally holds volunteers.manage_compliance. */
async function createComplianceManager(name: string, contactEmail: string) {
  const person = await prisma.person.create({ data: { name, contactEmail } });
  const role = await prisma.role.create({
    data: {
      name: `Compliance ${name}`,
      grants: { create: [{ permission: "volunteers.manage_compliance" }] },
    },
  });
  await prisma.roleAssignment.create({ data: { roleId: role.id, personId: person.id, termId: null } });
  return person;
}

describe("notifyDatelessCertReview", () => {
  it("notifies every compliance manager and returns the count", async () => {
    const m1 = await createComplianceManager("Cathy", "cathy@x.org");
    const m2 = await createComplianceManager("Carl", "carl@x.org");
    const volunteer = await prisma.person.create({ data: { name: "Val Volunteer" } });

    const count = await notifyDatelessCertReview(prisma, { id: volunteer.id, name: volunteer.name });

    expect(count).toBe(2);
    const notes = await prisma.notification.findMany({
      where: { type: "compliance-date-review" },
      orderBy: { personId: "asc" },
    });
    expect(notes.map((n) => n.personId).sort()).toEqual([m1.id, m2.id].sort());
    // The body names the volunteer and the link points at the review queue.
    for (const note of notes) {
      expect(note.body).toContain("Val Volunteer");
      expect(note.link).toMatch(/\/volunteers\/master$/);
    }
  });

  it("returns 0 and creates no review notifications when there are no managers", async () => {
    const volunteer = await prisma.person.create({ data: { name: "Val Volunteer" } });

    const count = await notifyDatelessCertReview(prisma, { id: volunteer.id, name: volunteer.name });

    expect(count).toBe(0);
    const notes = await prisma.notification.findMany({ where: { type: "compliance-date-review" } });
    expect(notes).toEqual([]);
  });

  it("does not notify the volunteer even when they are themselves a compliance manager", async () => {
    const other = await createComplianceManager("Cathy", "cathy@x.org");
    const selfManager = await createComplianceManager("Sam Self", "sam@x.org");

    const count = await notifyDatelessCertReview(prisma, { id: selfManager.id, name: selfManager.name });

    expect(count).toBe(1);
    const notes = await prisma.notification.findMany({ where: { type: "compliance-date-review" } });
    expect(notes.map((n) => n.personId)).toEqual([other.id]);
  });
});
