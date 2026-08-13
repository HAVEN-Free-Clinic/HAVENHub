import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  createAttending,
  updateAttending,
  canManageAnyRhdDept,
  attendingSchedule,
  AttendingValidationError,
  AttendingForbiddenError,
} from "./attendings";

const ACTOR = "actor-1";

/**
 * A manager of the reproductive health service line.
 *
 * A service line is a DepartmentDelegation MANAGER (see serviceLineDepartments),
 * so the delegation edge is what makes SRHD a service line at all. Creating SRHD
 * alone would leave `serviceLineDepartments()` empty and every scope check
 * false, which is the trap this fixture exists to avoid repeating.
 *
 * Returns the service line's id, which attendings now belong to.
 */
async function rhdManager(): Promise<string> {
  await prisma.person.create({ data: { id: ACTOR, name: "RHD Director" } });
  const managed = await prisma.department.upsert({
    where: { code: "SCTS" }, update: {}, create: { code: "SCTS", name: "SCTS Dept" },
  });
  const line = await prisma.department.upsert({
    where: { code: "SRHD" }, update: {}, create: { code: "SRHD", name: "Sexual and Reproductive Health" },
  });
  await prisma.departmentDelegation.create({
    data: { managerDepartmentId: line.id, managedDepartmentId: managed.id },
  });
  // schedule.edit_all makes every department manageable, including SRHD.
  const role = await prisma.role.create({
    data: { name: `r-${Date.now()}-${Math.random()}`, isSystem: false, grants: { create: [{ permission: "schedule.edit_all" }] } },
  });
  await prisma.roleAssignment.create({ data: { roleId: role.id, personId: ACTOR, termId: null } });
  return line.id;
}

beforeEach(resetDb);

describe("canManageAnyRhdDept", () => {
  it("is true for someone who manages a service line", async () => {
    await rhdManager(); // schedule.edit_all + SRHD manages SCTS
    expect(await canManageAnyRhdDept(ACTOR)).toBe(true);
  });

  it("is false for someone who manages no service line", async () => {
    await prisma.person.create({ data: { id: ACTOR, name: "Nobody" } });
    expect(await canManageAnyRhdDept(ACTOR)).toBe(false);
  });

  // A department with no delegation edges is not a service line, so managing it
  // confers no attending-roster rights however broad the schedule permission is.
  it("is false when a manageable department manages nothing", async () => {
    await prisma.person.create({ data: { id: ACTOR, name: "Lone Director" } });
    await prisma.department.upsert({
      where: { code: "ITCM" }, update: {}, create: { code: "ITCM", name: "IT" },
    });
    const role = await prisma.role.create({
      data: { name: `r-${Date.now()}-${Math.random()}`, isSystem: false, grants: { create: [{ permission: "schedule.edit_all" }] } },
    });
    await prisma.roleAssignment.create({ data: { roleId: role.id, personId: ACTOR, termId: null } });
    expect(await canManageAnyRhdDept(ACTOR)).toBe(false);
  });
});

describe("createAttending", () => {
  it("creates an attending with capabilities defaulting to unknown", async () => {
    const line = await rhdManager();
    const a = await createAttending(ACTOR, { scheduleName: "Rivera", fullName: "Dr. Rivera", departmentId: line });
    expect(a.scheduleName).toBe("Rivera");
    expect(a.iudIn).toBe("unknown");
    expect(a.isActive).toBe(true);
  });

  it("applies provided capabilities", async () => {
    const line = await rhdManager();
    const a = await createAttending(ACTOR, {
      scheduleName: "Chen",
      fullName: "Dr. Chen",
      departmentId: line,
      capabilities: { iudIn: "yes", gac: "no" },
    });
    expect(a.iudIn).toBe("yes");
    expect(a.gac).toBe("no");
    expect(a.emb).toBe("unknown");
  });

  it("rejects a duplicate scheduleName", async () => {
    const line = await rhdManager();
    await createAttending(ACTOR, { scheduleName: "Rivera", fullName: "Dr. Rivera", departmentId: line });
    await expect(
      createAttending(ACTOR, { scheduleName: "Rivera", fullName: "Other", departmentId: line }),
    ).rejects.toBeInstanceOf(AttendingValidationError);
  });

  it("rejects an invalid capability value", async () => {
    const line = await rhdManager();
    await expect(
      createAttending(ACTOR, { scheduleName: "X", fullName: "Y", departmentId: line, capabilities: { iudIn: "maybe" as never } }),
    ).rejects.toBeInstanceOf(AttendingValidationError);
  });

  it("rejects an actor who manages no RHD department", async () => {
    await prisma.person.create({ data: { id: ACTOR, name: "Nobody" } });
    await expect(
      createAttending(ACTOR, { scheduleName: "Z", fullName: "Z", departmentId: "no-such-line" }),
    ).rejects.toBeInstanceOf(AttendingForbiddenError);
  });
});

describe("updateAttending", () => {
  it("patches only provided fields", async () => {
    const line = await rhdManager();
    const a = await createAttending(ACTOR, { scheduleName: "Rivera", fullName: "Dr. Rivera", departmentId: line });
    const u = await updateAttending(ACTOR, a.id, { capabilities: { iudIn: "yes" }, notes: "fast" });
    expect(u.iudIn).toBe("yes");
    expect(u.notes).toBe("fast");
    expect(u.scheduleName).toBe("Rivera");
  });

  it("rejects renaming to an existing scheduleName", async () => {
    const line = await rhdManager();
    await createAttending(ACTOR, { scheduleName: "Rivera", fullName: "Dr. Rivera", departmentId: line });
    const b = await createAttending(ACTOR, { scheduleName: "Chen", fullName: "Dr. Chen", departmentId: line });
    await expect(
      updateAttending(ACTOR, b.id, { scheduleName: "Rivera" }),
    ).rejects.toBeInstanceOf(AttendingValidationError);
  });

  // The property the per-line scoping exists for. Managing ONE service line must
  // not confer edit rights over another's roster, which a "manages any service
  // line" check would have allowed once a second line existed.
  it("refuses to edit an attending belonging to a service line the actor does not manage", async () => {
    const rhdLine = await rhdManager();
    const theirs = await createAttending(ACTOR, {
      scheduleName: "Rivera", fullName: "Dr. Rivera", departmentId: rhdLine,
    });

    // A primary care director: manages PCAR's line only, by directorship rather
    // than the blanket schedule.edit_all the RHD fixture uses.
    const term = await prisma.term.create({
      data: { code: "FA26", name: "Fall", startDate: new Date(), endDate: new Date(), status: "ACTIVE" },
    });
    const pcar = await prisma.department.create({ data: { code: "PCAR", name: "Primary Care Advisors" } });
    const jctp = await prisma.department.create({ data: { code: "JCTP", name: "Junior Primary Care" } });
    await prisma.departmentDelegation.create({
      data: { managerDepartmentId: pcar.id, managedDepartmentId: jctp.id },
    });
    const pcarDirector = await prisma.person.create({ data: { name: "PCAR Director" } });
    await prisma.termMembership.create({
      data: { personId: pcarDirector.id, termId: term.id, departmentId: pcar.id, kind: "DIRECTOR", status: "ACTIVE" },
    });

    await expect(
      updateAttending(pcarDirector.id, theirs.id, { fullName: "Renamed By The Wrong Line" }),
    ).rejects.toBeInstanceOf(AttendingForbiddenError);

    // They can still manage their own line.
    const mine = await createAttending(pcarDirector.id, {
      scheduleName: "Okafor", fullName: "Dr. Okafor", departmentId: pcar.id,
    });
    expect(mine.departmentId).toBe(pcar.id);
  });
});

// Both attending pages build their capabilities object by mapping all six keys
// over FormData, so a line that does NOT render the procedure matrix posts six
// nulls. Taken literally that threw "Invalid capability value: null" and made it
// impossible to add or edit an attending on any line except reproductive health,
// which is the entire primary care roster.
describe("capability fields a form did not render", () => {
  it("createAttending treats null capabilities as absent, not invalid", async () => {
    const lineId = await rhdManager();

    const created = await createAttending(ACTOR, {
      scheduleName: "Okafor", fullName: "Dr. Okafor", departmentId: lineId,
      capabilities: { iudIn: null, iudOut: null, nexplanon: null, gac: null, emb: null, seesMale: null },
    });

    expect(created.iudIn).toBe("unknown");
    expect(created.seesMale).toBe("unknown");
  });

  it("updateAttending leaves existing capabilities alone when they arrive null", async () => {
    const lineId = await rhdManager();
    const created = await createAttending(ACTOR, {
      scheduleName: "Ellis", fullName: "Dr. Ellis", departmentId: lineId,
      capabilities: { iudIn: "yes", nexplanon: "no" },
    });

    const updated = await updateAttending(ACTOR, created.id, {
      fullName: "Dr. E Ellis",
      capabilities: { iudIn: null, iudOut: null, nexplanon: null, gac: null, emb: null, seesMale: null },
    });

    // A null must not silently reset a real qualification to "unknown".
    expect(updated.iudIn).toBe("yes");
    expect(updated.nexplanon).toBe("no");
    expect(updated.fullName).toBe("Dr. E Ellis");
  });

  it("still rejects a genuinely invalid capability value", async () => {
    const lineId = await rhdManager();

    await expect(
      createAttending(ACTOR, {
        scheduleName: "Bad", fullName: "Dr. Bad", departmentId: lineId,
        capabilities: { iudIn: "maybe" as never },
      }),
    ).rejects.toBeInstanceOf(AttendingValidationError);
  });
});

describe("attendingSchedule", () => {
  /** An ACTIVE term whose clinic dates are noon-UTC anchored, like every other
   *  calendar marker in the schema. */
  async function activeTerm(dateKeys: string[]) {
    return prisma.term.create({
      data: {
        code: "SU26", name: "Summer 2026", status: "ACTIVE",
        startDate: new Date("2026-05-01T12:00:00Z"), endDate: new Date("2026-08-31T12:00:00Z"),
        clinicDates: dateKeys.map((k) => new Date(`${k}T12:00:00Z`)),
      },
    });
  }

  it("marks only the procedure line as using procedures", async () => {
    const lineId = await rhdManager();
    const jctp = await prisma.department.create({ data: { code: "JCTP", name: "JCTP Dept" } });
    const pcar = await prisma.department.create({ data: { code: "PCAR", name: "Primary Care" } });
    await prisma.departmentDelegation.create({
      data: { managerDepartmentId: pcar.id, managedDepartmentId: jctp.id },
    });
    await activeTerm(["2026-05-30"]);

    const schedule = await attendingSchedule();
    const byId = new Map(schedule.lines.map((l) => [l.id, l]));

    expect(byId.get(lineId)?.usesProcedures).toBe(true);
    // A primary care attending has no IUD or Nexplanon qualification; offering
    // a procedures field would imply a gap rather than an inapplicable question.
    expect(byId.get(pcar.id)?.usesProcedures).toBe(false);
  });

  it("carries the raw attendingId even when that attending is deactivated", async () => {
    const lineId = await rhdManager();
    const term = await activeTerm(["2026-05-30"]);
    const attending = await prisma.rhdAttending.create({
      data: { scheduleName: "Dr. Gone", fullName: "Dr. Gone", departmentId: lineId, isActive: false },
    });
    await prisma.rhdClinic.create({
      data: { termId: term.id, departmentId: lineId, clinicDate: new Date("2026-05-30T12:00:00Z"), attendingId: attending.id },
    });

    const schedule = await attendingSchedule();
    const cell = schedule.dates[0].byLine[lineId];

    // Reads as a gap to fill...
    expect(cell.attendingName).toBeNull();
    // ...but the editor still round-trips the value, so saving an unrelated
    // field on this cell cannot silently clear the assignment.
    expect(cell.attendingId).toBe(attending.id);
    expect(schedule.optionsByLine[lineId].map((o) => o.id)).toContain(attending.id);
  });

  it("offers active options before inactive ones", async () => {
    const lineId = await rhdManager();
    await activeTerm(["2026-05-30"]);
    await prisma.rhdAttending.create({
      data: { scheduleName: "Aaa Inactive", fullName: "A", departmentId: lineId, isActive: false },
    });
    await prisma.rhdAttending.create({
      data: { scheduleName: "Zzz Active", fullName: "Z", departmentId: lineId, isActive: true },
    });

    const schedule = await attendingSchedule();

    // Alphabetically the inactive one sorts first, so ordering by name alone
    // would bury the assignable option beneath a deactivated one.
    expect(schedule.optionsByLine[lineId].map((o) => o.isActive)).toEqual([true, false]);
  });

  it("returns a null termId and no dates when there is no active term", async () => {
    await rhdManager();

    const schedule = await attendingSchedule();

    // The page renders an empty state from this and must not offer an editor,
    // which would post an empty termId.
    expect(schedule.termId).toBeNull();
    expect(schedule.dates).toEqual([]);
    expect(schedule.emptyReason).toBe("no-active-term");
  });

  // Three unrelated causes used to render as "No clinic dates in the active
  // term yet". A clinic with 17 clinic dates and no delegations configured was
  // told it had no clinic dates, which sends whoever reads it to the one place
  // that is not the problem.
  it("distinguishes no service lines from no clinic dates", async () => {
    // A term with dates, but nothing that counts as a service line: the
    // delegation edge is what makes a department one, and there is none here.
    await prisma.person.create({ data: { id: "solo-actor", name: "Solo" } });
    await prisma.department.create({ data: { code: "SCTS", name: "SCTS Dept" } });
    await prisma.term.create({
      data: {
        code: "SU26", name: "Summer 2026", status: "ACTIVE",
        startDate: new Date("2026-05-01T12:00:00Z"), endDate: new Date("2026-08-31T12:00:00Z"),
        clinicDates: [new Date("2026-05-30T12:00:00Z")],
      },
    });

    const schedule = await attendingSchedule();

    expect(schedule.emptyReason).toBe("no-service-lines");
    expect(schedule.dates).toEqual([]);
  });

  it("reports no clinic dates only when the active term really has none", async () => {
    await rhdManager();
    await prisma.term.create({
      data: {
        code: "SU26", name: "Summer 2026", status: "ACTIVE",
        startDate: new Date("2026-05-01T12:00:00Z"), endDate: new Date("2026-08-31T12:00:00Z"),
        clinicDates: [],
      },
    });

    const schedule = await attendingSchedule();

    expect(schedule.emptyReason).toBe("no-clinic-dates");
  });
});

