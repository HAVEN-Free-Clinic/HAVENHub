import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { runShiftClearanceDigests } from "./shift-clearance-digest";

const NOW = new Date();

/** A clinic date `daysAhead` in the future, anchored at 12:00 UTC. */
function futureClinicDate(daysAhead: number): Date {
  const d = new Date(NOW);
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + daysAhead);
  return d;
}

beforeEach(async () => {
  await resetDb();
});

async function createTerm(clinicDates: Date[]) {
  return prisma.term.create({
    data: {
      code: "FA26",
      name: "Fall 2026",
      startDate: new Date(NOW.getTime() - 60 * 86_400_000),
      endDate: new Date(NOW.getTime() + 60 * 86_400_000),
      status: "ACTIVE",
      clinicDates,
    },
  });
}
async function createDepartment(code: string, name: string) {
  return prisma.department.upsert({ where: { code }, update: { name }, create: { code, name } });
}
async function createPerson(name: string, contactEmail: string | null) {
  return prisma.person.create({ data: { name, contactEmail, status: "ACTIVE" } });
}
async function member(termId: string, departmentId: string, personId: string, kind: "DIRECTOR" | "VOLUNTEER") {
  return prisma.termMembership.create({ data: { personId, termId, departmentId, kind, status: "ACTIVE" } });
}
async function schedule(termId: string, departmentId: string, personId: string, clinicDate: Date, role: "DIRECTOR" | "VOLUNTEER") {
  return prisma.shiftAssignment.create({ data: { termId, departmentId, personId, clinicDate, role } });
}
function digestEmails() {
  return prisma.emailLog.findMany({ where: { template: "shift-clearance-digest" }, select: { toEmail: true, subject: true, html: true } });
}

describe("runShiftClearanceDigests", () => {
  it("emails the department director about an uncleared scheduled volunteer, once", async () => {
    const target = futureClinicDate(3);
    const term = await createTerm([target]);
    const sctp = await createDepartment("SCTP", "Senior Primary Care");
    const jctp = await createDepartment("JCTP", "Junior Primary Care");

    const vol = await createPerson("Val Volunteer", "val@x.org");
    const dir = await createPerson("Dana Director", "dana@x.org");
    const other = await createPerson("Otto Otherdir", "otto@x.org");
    await member(term.id, sctp.id, vol.id, "VOLUNTEER");
    await member(term.id, sctp.id, dir.id, "DIRECTOR");
    await member(term.id, jctp.id, other.id, "DIRECTOR");
    await schedule(term.id, sctp.id, vol.id, target, "VOLUNTEER");

    const r = await runShiftClearanceDigests(NOW);
    expect(r.digestsSent).toBe(1);
    expect(r.unclearedOnShift).toBe(1);

    const emails = await digestEmails();
    expect(emails).toHaveLength(1);
    expect(emails[0].toEmail).toBe("dana@x.org");
    expect(emails[0].html).toContain("Val Volunteer");
    // Val has no HIPAA certificate on file.
    expect(emails[0].html).toContain("HIPAA certificate");

    // A re-fired run for the same clinic day sends nothing new.
    const again = await runShiftClearanceDigests(NOW);
    expect(again.digestsSent).toBe(0);
    expect(await digestEmails()).toHaveLength(1);
  });

  it("ignores a leftover assignment for someone no longer active in the department", async () => {
    const target = futureClinicDate(3);
    const term = await createTerm([target]);
    const sctp = await createDepartment("SCTP", "Senior Primary Care");
    const gone = await createPerson("Gone Person", "gone@x.org");
    const dir = await createPerson("Dana Director", "dana@x.org");
    await member(term.id, sctp.id, dir.id, "DIRECTOR");
    await schedule(term.id, sctp.id, gone.id, target, "VOLUNTEER");

    const r = await runShiftClearanceDigests(NOW);
    expect(r.digestsSent).toBe(0);
    expect(await digestEmails()).toHaveLength(0);
  });

  it("does nothing on a break week when the next clinic is more than six days out", async () => {
    const target = futureClinicDate(10);
    const term = await createTerm([target]);
    const sctp = await createDepartment("SCTP", "Senior Primary Care");
    const vol = await createPerson("Val Volunteer", "val@x.org");
    const dir = await createPerson("Dana Director", "dana@x.org");
    await member(term.id, sctp.id, vol.id, "VOLUNTEER");
    await member(term.id, sctp.id, dir.id, "DIRECTOR");
    await schedule(term.id, sctp.id, vol.id, target, "VOLUNTEER");

    const r = await runShiftClearanceDigests(NOW);
    expect(r.digestsSent).toBe(0);
  });
});
