/**
 * Which attending covers which department.
 *
 * The rule under test: a schedule column names the clinical PARENT, and the
 * teams under it reach that column through exactly one hop of
 * DepartmentDelegation. That is what lets the mapping stay on a handful of
 * departments instead of all forty, and it is the path both the member's shift
 * card and the weekly reminder email walk.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { departmentSlotIds, departmentAttendingsForDates } from "./coverage";

const DATE = new Date("2026-05-30T12:00:00Z");
const DATE_KEY = "2026-05-30";

beforeEach(resetDb);

async function dept(code: string) {
  return prisma.department.create({ data: { code, name: `${code} Dept` } });
}

async function delegate(managerId: string, managedId: string) {
  await prisma.departmentDelegation.create({
    data: { managerDepartmentId: managerId, managedDepartmentId: managedId },
  });
}

async function slot(
  label: string,
  order: number,
  departmentId: string | null,
  allowsMultiple = false,
) {
  return prisma.clinicSlot.create({
    data: { label, startTime: "09:00", endTime: "13:00", order, allowsMultiple, departmentId },
  });
}

async function attending(scheduleName: string, isActive = true) {
  return prisma.attending.create({ data: { scheduleName, fullName: scheduleName, isActive } });
}

async function term() {
  return prisma.term.create({
    data: {
      code: "SU26",
      name: "Summer 2026",
      status: "ACTIVE",
      startDate: new Date("2026-05-01T12:00:00Z"),
      endDate: new Date("2026-08-31T12:00:00Z"),
      clinicDates: [DATE],
    },
  });
}

async function staff(
  termId: string,
  entries: Array<{ slotId: string; attendingId: string }>,
  opts: { isClosed?: boolean } = {},
) {
  return prisma.clinicDay.create({
    data: {
      termId,
      clinicDate: DATE,
      isClosed: opts.isClosed ?? false,
      attendings: { create: entries.map((e, order) => ({ ...e, order })) },
    },
  });
}

describe("departmentSlotIds", () => {
  it("finds the columns naming the department outright", async () => {
    const pcar = await dept("PCAR");
    const morning = await slot("9am-12pm", 0, pcar.id, true);
    const midday = await slot("11am-2pm", 1, pcar.id);
    await slot("Shadowing", 2, null);

    expect(await departmentSlotIds(pcar.id)).toEqual([morning.id, midday.id]);
  });

  it("reaches a parent's columns through one hop of delegation", async () => {
    const srhd = await dept("SRHD");
    const jcts = await dept("JCTS");
    await delegate(srhd.id, jcts.id);
    const rhd = await slot("RHD Attending", 0, srhd.id);

    // JCTS is named on no column; it is covered because SRHD manages it.
    expect(await departmentSlotIds(jcts.id)).toEqual([rhd.id]);
  });

  it("does not follow a second hop", async () => {
    const grandparent = await dept("EXEC");
    const parent = await dept("SRHD");
    const child = await dept("JCTS");
    await delegate(grandparent.id, parent.id);
    await delegate(parent.id, child.id);
    await slot("Exec Column", 0, grandparent.id);

    // Delegation is an oversight edge. Following it transitively would hand
    // JCTS an attending two removes away who does not cover them.
    expect(await departmentSlotIds(child.id)).toEqual([]);
  });

  it("returns nothing for a department on no column and under no parent", async () => {
    const pcar = await dept("PCAR");
    const pham = await dept("PHAM");
    await slot("9am-12pm", 0, pcar.id, true);

    expect(await departmentSlotIds(pham.id)).toEqual([]);
  });
});

describe("departmentAttendingsForDates", () => {
  it("returns only the columns covering the department, in column order", async () => {
    const t = await term();
    const pcar = await dept("PCAR");
    const srhd = await dept("SRHD");
    const sctp = await dept("SCTP");
    await delegate(pcar.id, sctp.id);

    const morning = await slot("9am-12pm", 0, pcar.id, true);
    const midday = await slot("11am-2pm", 1, pcar.id);
    const rhd = await slot("RHD Attending", 2, srhd.id);

    const peggy = await attending("Peggy Bia");
    const chen = await attending("Chen");
    const finch = await attending("Finch");
    await staff(t.id, [
      { slotId: morning.id, attendingId: peggy.id },
      { slotId: midday.id, attendingId: chen.id },
      { slotId: rhd.id, attendingId: finch.id },
    ]);

    const byDate = await departmentAttendingsForDates(t.id, [DATE], sctp.id);
    // Finch is on the same clinic day and deliberately absent: the
    // reproductive health column does not cover a primary care team.
    expect(byDate.get(DATE_KEY)?.map((a) => [a.name, a.slotLabel])).toEqual([
      ["Peggy Bia", "9am-12pm"],
      ["Chen", "11am-2pm"],
    ]);
  });

  it("leaves a date with nobody ABSENT from the map rather than empty", async () => {
    const t = await term();
    const pcar = await dept("PCAR");
    await slot("9am-12pm", 0, pcar.id, true);

    const byDate = await departmentAttendingsForDates(t.id, [DATE], pcar.id);
    // Absence is what callers render as "not announced yet"; an empty array
    // would be indistinguishable from a staffed-then-cleared column.
    expect(byDate.has(DATE_KEY)).toBe(false);
  });

  it("staffs nobody on a closed date", async () => {
    const t = await term();
    const pcar = await dept("PCAR");
    const morning = await slot("9am-12pm", 0, pcar.id, true);
    const peggy = await attending("Peggy Bia");
    await staff(t.id, [{ slotId: morning.id, attendingId: peggy.id }], { isClosed: true });

    expect((await departmentAttendingsForDates(t.id, [DATE], pcar.id)).has(DATE_KEY)).toBe(false);
  });

  it("omits a deactivated attending", async () => {
    const t = await term();
    const pcar = await dept("PCAR");
    const morning = await slot("9am-12pm", 0, pcar.id, true);
    const retired = await attending("Dr. Retired", false);
    await staff(t.id, [{ slotId: morning.id, attendingId: retired.id }]);

    // The row is kept so a manager sees the gap, but naming them here would
    // read as a staffed column to the member.
    expect((await departmentAttendingsForDates(t.id, [DATE], pcar.id)).has(DATE_KEY)).toBe(false);
  });

  it("returns an empty map for a department that maps to no column", async () => {
    const t = await term();
    const pcar = await dept("PCAR");
    const pham = await dept("PHAM");
    const morning = await slot("9am-12pm", 0, pcar.id, true);
    const peggy = await attending("Peggy Bia");
    await staff(t.id, [{ slotId: morning.id, attendingId: peggy.id }]);

    expect((await departmentAttendingsForDates(t.id, [DATE], pham.id)).size).toBe(0);
  });

  it("returns an empty map when asked about no dates at all", async () => {
    const t = await term();
    const pcar = await dept("PCAR");
    expect((await departmentAttendingsForDates(t.id, [], pcar.id)).size).toBe(0);
  });
});
