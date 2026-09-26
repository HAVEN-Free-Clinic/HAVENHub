import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { myProfileTool } from "./profile";

beforeEach(resetDb);

async function terms() {
  const live = await prisma.term.create({
    data: { code: "FA26", name: "Fall 2026", startDate: new Date("2026-09-01"), endDate: new Date("2026-12-15"), status: "ACTIVE" },
  });
  const next = await prisma.term.create({
    data: { code: "SP27", name: "Spring 2027", startDate: new Date("2027-01-15"), endDate: new Date("2027-05-15"), status: "PLANNING" },
  });
  const past = await prisma.term.create({
    data: { code: "SU26", name: "Summer 2026", startDate: new Date("2026-05-30"), endDate: new Date("2026-08-30"), status: "ARCHIVED" },
  });
  return { live, next, past };
}

describe("my_profile", () => {
  it("lists the member's role and department for the current term, then the upcoming one", async () => {
    const t = await terms();
    const nursing = await prisma.department.create({ data: { code: "NURS", name: "Nursing" } });
    const triage = await prisma.department.create({ data: { code: "TRIA", name: "Triage" } });
    const me = await prisma.person.create({ data: { name: "Pat Member" } });
    await prisma.termMembership.createMany({
      data: [
        { personId: me.id, termId: t.live.id, departmentId: triage.id, kind: "VOLUNTEER", status: "ACTIVE" },
        { personId: me.id, termId: t.live.id, departmentId: nursing.id, kind: "DIRECTOR", status: "ACTIVE" },
        { personId: me.id, termId: t.next.id, departmentId: nursing.id, kind: "DIRECTOR", status: "ACTIVE" },
        // Not in the answer: an archived term is neither current nor upcoming.
        { personId: me.id, termId: t.past.id, departmentId: triage.id, kind: "VOLUNTEER", status: "ACTIVE" },
      ],
    });

    const text = await myProfileTool.run({ personId: me.id }, {});

    expect(text).toBe(
      "You are signed in as Pat Member. Fall 2026 (current term): Director in Nursing; Volunteer in Triage. Spring 2027 (upcoming term): Director in Nursing."
    );
  });

  it("says plainly when the member is not on any current or upcoming roster", async () => {
    await terms();
    const me = await prisma.person.create({ data: { name: "Pat Alum" } });

    const text = await myProfileTool.run({ personId: me.id }, {});

    expect(text).toMatch(/^You are signed in as Pat Alum\. You are not on the roster/);
    expect(text).toMatch(/\/my-info\.$/);
  });

  it("never renders contact details or identifiers", async () => {
    const t = await terms();
    const dept = await prisma.department.create({ data: { code: "NURS", name: "Nursing" } });
    const me = await prisma.person.create({
      data: { name: "Pat Private", netId: "pp123", contactEmail: "pat@example.org", phone: "2035550100" },
    });
    await prisma.termMembership.create({
      data: { personId: me.id, termId: t.live.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" },
    });

    const text = await myProfileTool.run({ personId: me.id }, {});

    expect(text).not.toContain("pp123");
    expect(text).not.toContain("pat@example.org");
    expect(text).not.toContain("2035550100");
  });

  it("takes no input at all", () => {
    expect(Object.keys(myProfileTool.inputSchema.shape)).toEqual([]);
  });
});
