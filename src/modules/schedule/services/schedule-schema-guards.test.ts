import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";

/**
 * Guards for raw-SQL constraints on the schedule module that Prisma cannot
 * express in schema.prisma. These tests exist so that a future generated
 * migration cannot silently drop the index without CI catching it.
 *
 * See also: src/platform/rbac/schema-guards.test.ts for the same pattern on
 * RoleAssignment.
 */
describe("schedule db-level schema guards", () => {
  beforeEach(resetDb);

  it("ShiftRequest_pending_unique index exists in pg_indexes", async () => {
    const result = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname
      FROM pg_indexes
      WHERE tablename = 'ShiftRequest'
        AND indexname = 'ShiftRequest_pending_unique'
    `;
    expect(result).toHaveLength(1);
    expect(result[0].indexname).toBe("ShiftRequest_pending_unique");
  });

  it("AttendingShiftRequest_pending_unique index exists in pg_indexes", async () => {
    const result = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname
      FROM pg_indexes
      WHERE tablename = 'AttendingShiftRequest'
        AND indexname = 'AttendingShiftRequest_pending_unique'
    `;
    expect(result).toHaveLength(1);
    expect(result[0].indexname).toBe("AttendingShiftRequest_pending_unique");
  });

  /**
   * Non-vacuous: the index has to be PARTIAL. A plain unique on the triple would
   * also satisfy the existence check above while making a second request for a
   * seat impossible forever, since a CANCELLED or DENIED row would keep blocking
   * it.
   */
  it("allows a second request for a seat once the first is no longer PENDING", async () => {
    const term = await prisma.term.create({
      data: {
        code: "SU99",
        name: "Summer 2099",
        status: "ACTIVE",
        startDate: new Date("2099-05-01T12:00:00Z"),
        endDate: new Date("2099-08-31T12:00:00Z"),
      },
    });
    const day = await prisma.clinicDay.create({
      data: { termId: term.id, clinicDate: new Date("2099-05-02T12:00:00Z") },
    });
    const slot = await prisma.clinicSlot.create({
      data: { label: "9am-12pm", startTime: "09:00", endTime: "12:00", order: 0 },
    });
    const attending = await prisma.attending.create({
      data: { scheduleName: "Peggy Bia", fullName: "Bia, Margaret" },
    });
    const base = {
      termId: term.id,
      requesterId: attending.id,
      requesterDayId: day.id,
      requesterSlotId: slot.id,
    };

    const first = await prisma.attendingShiftRequest.create({ data: base });
    await expect(prisma.attendingShiftRequest.create({ data: base })).rejects.toThrow();

    await prisma.attendingShiftRequest.update({ where: { id: first.id }, data: { status: "CANCELLED" } });
    await expect(prisma.attendingShiftRequest.create({ data: base })).resolves.toBeTruthy();
  });
});
