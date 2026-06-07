import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  saturdaysBetween,
  listTerms,
  createTerm,
  activateTerm,
  archiveTerm,
  updateClinicDates,
  TermConflictError,
  TermNotFoundError,
  TermDateError,
} from "./terms";

const ACTOR = "actor-person-id";

// ---------------------------------------------------------------------------
// saturdaysBetween (pure, no DB)
// ---------------------------------------------------------------------------

describe("saturdaysBetween", () => {
  it("returns 18 Saturdays for the SU26 range 2026-05-30..2026-09-26", () => {
    const dates = saturdaysBetween("2026-05-30", "2026-09-26");
    expect(dates).toHaveLength(18);
  });

  it("every returned date is a Saturday (UTC day-of-week = 6)", () => {
    const dates = saturdaysBetween("2026-05-30", "2026-09-26");
    for (const d of dates) {
      expect(d.getUTCDay()).toBe(6);
    }
  });

  it("every returned date is anchored at noon UTC (12:00:00Z)", () => {
    const dates = saturdaysBetween("2026-05-30", "2026-09-26");
    for (const d of dates) {
      expect(d.getUTCHours()).toBe(12);
      expect(d.getUTCMinutes()).toBe(0);
      expect(d.getUTCSeconds()).toBe(0);
    }
  });

  it("is inclusive of both bound dates when they are Saturdays", () => {
    const dates = saturdaysBetween("2026-05-30", "2026-09-26");
    // 2026-05-30 and 2026-09-26 are both Saturdays
    expect(dates[0].toISOString()).toBe("2026-05-30T12:00:00.000Z");
    expect(dates[dates.length - 1].toISOString()).toBe("2026-09-26T12:00:00.000Z");
  });

  it("returns an empty array when there are no Saturdays in the range", () => {
    // 2026-06-01 (Mon) to 2026-06-05 (Fri) - no Saturday
    const dates = saturdaysBetween("2026-06-01", "2026-06-05");
    expect(dates).toHaveLength(0);
  });

  it("returns exactly one date when start === end and it is a Saturday", () => {
    const dates = saturdaysBetween("2026-05-30", "2026-05-30");
    expect(dates).toHaveLength(1);
    expect(dates[0].toISOString()).toBe("2026-05-30T12:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// createTerm
// ---------------------------------------------------------------------------

describe("createTerm", () => {
  beforeEach(resetDb);

  it("creates a term with PLANNING status and uppercases + trims the code", async () => {
    const term = await createTerm(ACTOR, {
      code: " su26 ",
      name: "Summer 2026",
      startDate: "2026-05-30",
      endDate: "2026-09-26",
    });

    expect(term.status).toBe("PLANNING");
    expect(term.code).toBe("SU26");
  });

  it("populates clinicDates with Saturdays between start and end", async () => {
    const term = await createTerm(ACTOR, {
      code: "SU26",
      name: "Summer 2026",
      startDate: "2026-05-30",
      endDate: "2026-09-26",
    });

    expect(term.clinicDates).toHaveLength(18);
    for (const d of term.clinicDates) {
      expect(d.getUTCDay()).toBe(6);
      expect(d.getUTCHours()).toBe(12);
    }
  });

  it("writes an audit entry with action term.create", async () => {
    const term = await createTerm(ACTOR, {
      code: "FA26",
      name: "Fall 2026",
      startDate: "2026-09-01",
      endDate: "2026-12-15",
    });

    const logs = await prisma.auditLog.findMany({ where: { entityId: term.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe("term.create");
    expect(logs[0].actorPersonId).toBe(ACTOR);
  });

  it("throws TermConflictError on exact duplicate code (case-insensitive)", async () => {
    await createTerm(ACTOR, {
      code: "SU26",
      name: "Summer 2026",
      startDate: "2026-05-30",
      endDate: "2026-09-26",
    });

    await expect(
      createTerm(ACTOR, {
        code: "SU26",
        name: "Summer 2026 Dup",
        startDate: "2026-05-30",
        endDate: "2026-09-26",
      })
    ).rejects.toBeInstanceOf(TermConflictError);
  });

  it("throws TermConflictError on case-variant duplicate code (su26 vs SU26)", async () => {
    await createTerm(ACTOR, {
      code: "SU26",
      name: "Summer 2026",
      startDate: "2026-05-30",
      endDate: "2026-09-26",
    });

    await expect(
      createTerm(ACTOR, {
        code: "su26",
        name: "Summer 2026 Lower",
        startDate: "2026-05-30",
        endDate: "2026-09-26",
      })
    ).rejects.toBeInstanceOf(TermConflictError);
  });

  it("throws TermDateError when endDate overflows the calendar (2026-02-30) (I2)", async () => {
    await expect(
      createTerm(ACTOR, {
        code: "BAD1",
        name: "Bad Term",
        startDate: "2026-02-01",
        endDate: "2026-02-30",
      })
    ).rejects.toBeInstanceOf(TermDateError);
  });
});

// ---------------------------------------------------------------------------
// activateTerm
// ---------------------------------------------------------------------------

describe("activateTerm", () => {
  beforeEach(resetDb);

  async function seedTerm(code: string, status: "PLANNING" | "ACTIVE" | "ARCHIVED") {
    return prisma.term.create({
      data: {
        code,
        name: `Term ${code}`,
        startDate: new Date("2026-01-01T12:00:00Z"),
        endDate: new Date("2026-04-30T12:00:00Z"),
        status,
      },
    });
  }

  it("activates a PLANNING term and archives the current ACTIVE term atomically", async () => {
    const oldActive = await seedTerm("FA25", "ACTIVE");
    const newTerm = await seedTerm("SU26", "PLANNING");

    const result = await activateTerm(ACTOR, newTerm.id);

    expect(result.status).toBe("ACTIVE");

    const reloaded = await prisma.term.findUnique({ where: { id: oldActive.id } });
    expect(reloaded!.status).toBe("ARCHIVED");
  });

  it("leaves exactly one ACTIVE term after the swap", async () => {
    const oldActive = await seedTerm("FA25", "ACTIVE");
    const newTerm = await seedTerm("SU26", "PLANNING");

    await activateTerm(ACTOR, newTerm.id);

    const activeTerms = await prisma.term.findMany({ where: { status: "ACTIVE" } });
    expect(activeTerms).toHaveLength(1);
    expect(activeTerms[0].id).toBe(newTerm.id);

    // Silence unused variable warning
    void oldActive;
  });

  it("writes exactly two audit rows: term.archive for displaced and term.activate for target", async () => {
    const oldActive = await seedTerm("FA25", "ACTIVE");
    const newTerm = await seedTerm("SU26", "PLANNING");

    await activateTerm(ACTOR, newTerm.id);

    const archiveLogs = await prisma.auditLog.findMany({
      where: { entityId: oldActive.id, action: "term.archive" },
    });
    expect(archiveLogs).toHaveLength(1);
    expect((archiveLogs[0].before as Record<string, unknown>).status).toBe("ACTIVE");
    expect((archiveLogs[0].after as Record<string, unknown>).status).toBe("ARCHIVED");

    const activateLogs = await prisma.auditLog.findMany({
      where: { entityId: newTerm.id, action: "term.activate" },
    });
    expect(activateLogs).toHaveLength(1);
    expect(activateLogs[0].before).toMatchObject({ status: "PLANNING" });
    expect(activateLogs[0].after).toMatchObject({ status: "ACTIVE" });
  });

  it("is a no-op (returns term, writes no audit) when target is already ACTIVE", async () => {
    const term = await seedTerm("SU26", "ACTIVE");
    const auditCountBefore = await prisma.auditLog.count();

    const result = await activateTerm(ACTOR, term.id);

    expect(result.status).toBe("ACTIVE");
    const auditCountAfter = await prisma.auditLog.count();
    expect(auditCountAfter).toBe(auditCountBefore);
  });

  it("activates with no prior ACTIVE term (one ACTIVE total, one audit row: term.activate)", async () => {
    const newTerm = await seedTerm("SU26", "PLANNING");

    await activateTerm(ACTOR, newTerm.id);

    const activeTerms = await prisma.term.findMany({ where: { status: "ACTIVE" } });
    expect(activeTerms).toHaveLength(1);

    const auditLogs = await prisma.auditLog.findMany({ where: { action: "term.archive" } });
    expect(auditLogs).toHaveLength(0);

    const activateLogs = await prisma.auditLog.findMany({ where: { action: "term.activate" } });
    expect(activateLogs).toHaveLength(1);
  });

  it("throws TermNotFoundError when target id does not exist", async () => {
    await expect(activateTerm(ACTOR, "nonexistent-id")).rejects.toBeInstanceOf(TermNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// archiveTerm
// ---------------------------------------------------------------------------

describe("archiveTerm", () => {
  beforeEach(resetDb);

  it("sets the term status to ARCHIVED", async () => {
    const term = await prisma.term.create({
      data: {
        code: "SU26",
        name: "Summer 2026",
        startDate: new Date("2026-05-30T12:00:00Z"),
        endDate: new Date("2026-09-26T12:00:00Z"),
        status: "ACTIVE",
      },
    });

    const result = await archiveTerm(ACTOR, term.id);
    expect(result.status).toBe("ARCHIVED");
  });

  it("writes an audit entry with action term.archive and before/after status", async () => {
    const term = await prisma.term.create({
      data: {
        code: "SU26",
        name: "Summer 2026",
        startDate: new Date("2026-05-30T12:00:00Z"),
        endDate: new Date("2026-09-26T12:00:00Z"),
        status: "ACTIVE",
      },
    });

    await archiveTerm(ACTOR, term.id);

    const logs = await prisma.auditLog.findMany({ where: { entityId: term.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe("term.archive");
    expect((logs[0].before as Record<string, unknown>).status).toBe("ACTIVE");
    expect((logs[0].after as Record<string, unknown>).status).toBe("ARCHIVED");
  });

  it("archiving the only ACTIVE term leaves no ACTIVE terms (allowed)", async () => {
    const term = await prisma.term.create({
      data: {
        code: "SU26",
        name: "Summer 2026",
        startDate: new Date("2026-05-30T12:00:00Z"),
        endDate: new Date("2026-09-26T12:00:00Z"),
        status: "ACTIVE",
      },
    });

    await archiveTerm(ACTOR, term.id);

    const activeTerms = await prisma.term.findMany({ where: { status: "ACTIVE" } });
    expect(activeTerms).toHaveLength(0);
  });

  it("throws TermNotFoundError when id does not exist", async () => {
    await expect(archiveTerm(ACTOR, "nonexistent-id")).rejects.toBeInstanceOf(TermNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// updateClinicDates
// ---------------------------------------------------------------------------

describe("updateClinicDates", () => {
  beforeEach(resetDb);

  async function seedTerm() {
    return prisma.term.create({
      data: {
        code: "SU26",
        name: "Summer 2026",
        startDate: new Date("2026-05-30T12:00:00Z"),
        endDate: new Date("2026-09-26T12:00:00Z"),
        status: "ACTIVE",
        clinicDates: [new Date("2026-06-06T12:00:00Z"), new Date("2026-06-13T12:00:00Z")],
      },
    });
  }

  it("replaces clinic dates with the normalized, deduped, sorted set", async () => {
    const term = await seedTerm();

    // input: duplicates, out-of-order, non-noon timestamps
    const result = await updateClinicDates(ACTOR, term.id, [
      "2026-07-04T18:30:00Z", // not noon - normalize to 2026-07-04 noon
      "2026-06-06",            // YYYY-MM-DD format -> noon
      "2026-07-04",            // duplicate of 2026-07-04 after normalization
      "2026-05-30T00:00:00Z",  // non-noon - normalize to 2026-05-30 noon
    ]);

    // 3 unique dates after dedupe
    expect(result.clinicDates).toHaveLength(3);

    // all anchored at noon UTC
    for (const d of result.clinicDates) {
      expect(d.getUTCHours()).toBe(12);
      expect(d.getUTCMinutes()).toBe(0);
    }

    // sorted ascending
    const times = result.clinicDates.map((d) => d.getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("writes an audit entry with action term.dates and before/after COUNTS (not arrays)", async () => {
    const term = await seedTerm(); // 2 clinic dates

    await updateClinicDates(ACTOR, term.id, [
      "2026-06-06",
      "2026-06-13",
      "2026-06-20",
    ]);

    const logs = await prisma.auditLog.findMany({
      where: { entityId: term.id, action: "term.dates" },
    });
    expect(logs).toHaveLength(1);
    expect((logs[0].before as Record<string, unknown>).count).toBe(2);
    expect((logs[0].after as Record<string, unknown>).count).toBe(3);
  });

  it("throws TermNotFoundError when id does not exist", async () => {
    await expect(
      updateClinicDates(ACTOR, "nonexistent-id", ["2026-06-06"])
    ).rejects.toBeInstanceOf(TermNotFoundError);
  });

  it("throws TermDateError when a date string is garbage (I2)", async () => {
    const term = await seedTerm();
    await expect(
      updateClinicDates(ACTOR, term.id, ["garbage"])
    ).rejects.toBeInstanceOf(TermDateError);
  });

  it("throws TermDateError when a date overflows the calendar (2026-02-30) (I2)", async () => {
    const term = await seedTerm();
    await expect(
      updateClinicDates(ACTOR, term.id, ["2026-02-30"])
    ).rejects.toBeInstanceOf(TermDateError);
  });
});

// ---------------------------------------------------------------------------
// listTerms
// ---------------------------------------------------------------------------

describe("listTerms", () => {
  beforeEach(resetDb);

  it("returns terms with membership counts", async () => {
    await prisma.term.create({
      data: {
        code: "SU26",
        name: "Summer 2026",
        startDate: new Date("2026-05-30T12:00:00Z"),
        endDate: new Date("2026-09-26T12:00:00Z"),
        status: "ACTIVE",
      },
    });

    const terms = await listTerms();
    expect(terms).toHaveLength(1);
    expect(terms[0].code).toBe("SU26");
    expect(terms[0]._count.memberships).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// TermConflictError / TermNotFoundError
// ---------------------------------------------------------------------------

describe("TermConflictError", () => {
  it("is an instance of Error and carries a message", () => {
    const err = new TermConflictError("SU26");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(TermConflictError);
    expect(err.message).toContain("SU26");
    expect(err.name).toBe("TermConflictError");
  });
});

describe("TermNotFoundError", () => {
  it("is an instance of Error and carries the id", () => {
    const err = new TermNotFoundError("abc-123");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(TermNotFoundError);
    expect(err.id).toBe("abc-123");
    expect(err.message).toContain("abc-123");
    expect(err.name).toBe("TermNotFoundError");
  });
});

describe("TermDateError", () => {
  it("is an instance of Error and carries the input", () => {
    const err = new TermDateError("garbage");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(TermDateError);
    expect(err.input).toBe("garbage");
    expect(err.message).toContain("garbage");
    expect(err.name).toBe("TermDateError");
  });
});
