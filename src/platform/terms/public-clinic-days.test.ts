import { beforeEach, describe, it, expect, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  publicClinicDays,
  selectPublicClinicDays,
  type ClinicDayAnnotation,
} from "./public-clinic-days";

// getActiveTerm is wrapped in React cache(), which memoizes for the life of the
// module registry rather than per test, and displayTodayKey resolves the real
// current date -- a suite pinned to fixed 2026 fixtures would start failing on
// its own the moment those dates went past. Both are stubbed for the same reason
// the rest of the suite stubs getActiveTerm: the term and "today" are inputs
// here, not the thing under test.
const mocks = vi.hoisted(() => ({
  getActiveTerm: vi.fn(),
  displayTodayKey: vi.fn(),
}));
vi.mock("./active-term", () => ({ getActiveTerm: mocks.getActiveTerm }));
vi.mock("@/platform/dates/today", () => ({ displayTodayKey: mocks.displayTodayKey }));

/** Clinic dates are stored anchored at noon UTC; mirror that in fixtures. */
function day(iso: string): Date {
  return new Date(`${iso}T12:00:00Z`);
}

function annotation(
  iso: string,
  over: Partial<Omit<ClinicDayAnnotation, "clinicDate">> = {}
): ClinicDayAnnotation {
  return { clinicDate: day(iso), isClosed: false, specialty: null, ...over };
}

const SATURDAYS = ["2026-08-22", "2026-08-29", "2026-09-05", "2026-09-12", "2026-09-19"];

describe("selectPublicClinicDays", () => {
  it("returns upcoming dates in chronological order", () => {
    const days = selectPublicClinicDays({
      clinicDates: SATURDAYS.map(day),
      annotations: [],
      todayKey: "2026-08-20",
      limit: 4,
    });
    expect(days.map((d) => d.date)).toEqual([
      "2026-08-22",
      "2026-08-29",
      "2026-09-05",
      "2026-09-12",
    ]);
  });

  it("keeps dates that have no ClinicDay row at all", () => {
    // The regression this whole module exists to avoid: an unannotated Saturday
    // is a normal open Saturday, not a missing one.
    const days = selectPublicClinicDays({
      clinicDates: SATURDAYS.map(day),
      annotations: [annotation("2026-09-05")],
      todayKey: "2026-08-20",
      limit: 10,
    });
    expect(days).toHaveLength(5);
  });

  it("drops a date marked closed", () => {
    const days = selectPublicClinicDays({
      clinicDates: SATURDAYS.map(day),
      annotations: [annotation("2026-08-29", { isClosed: true })],
      todayKey: "2026-08-20",
      limit: 10,
    });
    expect(days.map((d) => d.date)).not.toContain("2026-08-29");
    expect(days).toHaveLength(4);
  });

  it("excludes dates before today but includes today itself", () => {
    const days = selectPublicClinicDays({
      clinicDates: SATURDAYS.map(day),
      annotations: [],
      todayKey: "2026-08-29",
      limit: 10,
    });
    expect(days[0]?.date).toBe("2026-08-29");
    expect(days.map((d) => d.date)).not.toContain("2026-08-22");
  });

  it("names the specialty clinic running that day", () => {
    const days = selectPublicClinicDays({
      clinicDates: SATURDAYS.map(day),
      annotations: [
        annotation("2026-08-22", {
          specialty: { name: "Dermatology", runsSpecialtyClinic: true },
        }),
      ],
      todayKey: "2026-08-20",
      limit: 10,
    });
    expect(days[0]).toEqual({ date: "2026-08-22", specialty: "Dermatology" });
    expect(days[1]?.specialty).toBeNull();
  });

  it("withholds a specialty not flagged as a specialty clinic", () => {
    // runsSpecialtyClinic false means the column is carrying internal
    // bookkeeping, not a clinic patients can turn up for.
    const days = selectPublicClinicDays({
      clinicDates: SATURDAYS.map(day),
      annotations: [
        annotation("2026-08-22", {
          specialty: { name: "Reproductive Health", runsSpecialtyClinic: false },
        }),
      ],
      todayKey: "2026-08-20",
      limit: 10,
    });
    expect(days[0]?.specialty).toBeNull();
  });

  it("honours the limit", () => {
    const days = selectPublicClinicDays({
      clinicDates: SATURDAYS.map(day),
      annotations: [],
      todayKey: "2026-08-20",
      limit: 2,
    });
    expect(days).toHaveLength(2);
  });

  it("applies the limit after closed days are removed", () => {
    // Slicing before filtering would return one fewer day than asked for
    // whenever a closure fell inside the window.
    const days = selectPublicClinicDays({
      clinicDates: SATURDAYS.map(day),
      annotations: [annotation("2026-08-29", { isClosed: true })],
      todayKey: "2026-08-20",
      limit: 3,
    });
    expect(days.map((d) => d.date)).toEqual([
      "2026-08-22",
      "2026-09-05",
      "2026-09-12",
    ]);
  });

  it("sorts dates that are stored out of order", () => {
    const days = selectPublicClinicDays({
      clinicDates: [day("2026-09-05"), day("2026-08-22"), day("2026-08-29")],
      annotations: [],
      todayKey: "2026-08-20",
      limit: 10,
    });
    expect(days.map((d) => d.date)).toEqual([
      "2026-08-22",
      "2026-08-29",
      "2026-09-05",
    ]);
  });

  it("returns nothing when every clinic date is in the past", () => {
    const days = selectPublicClinicDays({
      clinicDates: SATURDAYS.map(day),
      annotations: [],
      todayKey: "2026-12-01",
      limit: 4,
    });
    expect(days).toEqual([]);
  });
});

describe("publicClinicDays", () => {
  beforeEach(async () => {
    await resetDb();
    mocks.displayTodayKey.mockResolvedValue("2026-08-20");
  });

  async function liveTerm(clinicDates: string[]) {
    const term = await prisma.term.create({
      data: {
        code: "SU26",
        name: "Summer 2026",
        startDate: day("2026-05-30"),
        endDate: day("2026-09-26"),
        status: "ACTIVE",
        clinicDates: clinicDates.map(day),
      },
    });
    mocks.getActiveTerm.mockResolvedValue(term);
    return term;
  }

  it("returns an empty list when no term is active", async () => {
    mocks.getActiveTerm.mockResolvedValue(null);
    expect(await publicClinicDays(4)).toEqual([]);
  });

  it("publishes every seeded Saturday, annotated or not", async () => {
    await liveTerm(SATURDAYS);
    const days = await publicClinicDays(4);
    expect(days.map((d) => d.date)).toEqual([
      "2026-08-22",
      "2026-08-29",
      "2026-09-05",
      "2026-09-12",
    ]);
    expect(days.every((d) => d.specialty === null)).toBe(true);
  });

  it("joins the specialty clinic and drops closed dates", async () => {
    const term = await liveTerm(SATURDAYS);
    const derm = await prisma.attendingSpecialty.create({
      data: { code: "DERM", name: "Dermatology", runsSpecialtyClinic: true, order: 1 },
    });
    await prisma.clinicDay.create({
      data: { termId: term.id, clinicDate: day("2026-08-22"), specialtyId: derm.id },
    });
    await prisma.clinicDay.create({
      data: {
        termId: term.id,
        clinicDate: day("2026-08-29"),
        isClosed: true,
        closedNote: "HAVEN FREE CLINIC CLOSED",
      },
    });

    const days = await publicClinicDays(4);
    expect(days[0]).toEqual({ date: "2026-08-22", specialty: "Dermatology" });
    expect(days.map((d) => d.date)).not.toContain("2026-08-29");
  });

  it("ignores ClinicDay rows belonging to another term", async () => {
    // The findMany is scoped by termId; without that scope an archived term's
    // closure could blank a live date that shares the same calendar day.
    const term = await liveTerm(SATURDAYS);
    const other = await prisma.term.create({
      data: {
        code: "SP26",
        name: "Spring 2026",
        startDate: day("2026-01-05"),
        endDate: day("2026-05-01"),
        status: "ARCHIVED",
        clinicDates: [],
      },
    });
    await prisma.clinicDay.create({
      data: { termId: other.id, clinicDate: day("2026-08-22"), isClosed: true },
    });
    expect(term.id).not.toBe(other.id);

    const days = await publicClinicDays(4);
    expect(days.map((d) => d.date)).toContain("2026-08-22");
  });

  it("never exposes the on-call attending or any other person", async () => {
    // The response shape is the access-control boundary on an unauthenticated
    // endpoint, so this asserts the absence rather than trusting the select.
    const term = await liveTerm(SATURDAYS);
    const attending = await prisma.attending.create({
      data: { scheduleName: "Example", fullName: "Dr. Example" },
    });
    await prisma.clinicDay.create({
      data: {
        termId: term.id,
        clinicDate: day("2026-08-22"),
        onCallAttendingId: attending.id,
        directorName: "A Director",
        proceduresBooked: 3,
      },
    });

    const days = await publicClinicDays(4);
    expect(Object.keys(days[0]!)).toEqual(["date", "specialty"]);
    expect(JSON.stringify(days)).not.toContain("Example");
    expect(JSON.stringify(days)).not.toContain("Director");
  });
});
