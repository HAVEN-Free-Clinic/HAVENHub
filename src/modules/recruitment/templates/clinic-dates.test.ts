import { describe, it, expect } from "vitest";
import { clinicDateOptions, resolveAvailabilityOptions, AVAILABILITY_FIELD_KEY } from "./clinic-dates";

/** Term.clinicDates entries are noon-UTC anchored (see prisma/schema.prisma). */
const noonUtc = (iso: string) => new Date(`${iso}T12:00:00.000Z`);

describe("clinicDateOptions", () => {
  it("maps a noon-UTC clinic date to its UTC day key with no off-by-one", () => {
    expect(clinicDateOptions([noonUtc("2026-06-06")])).toEqual([
      { value: "2026-06-06", label: "Sat, Jun 6" },
    ]);
  });

  it("sorts ascending regardless of input order", () => {
    const out = clinicDateOptions([noonUtc("2026-06-20"), noonUtc("2026-06-06")]);
    expect(out.map((o) => o.value)).toEqual(["2026-06-06", "2026-06-20"]);
  });

  it("labels a non-Saturday clinic date with its real weekday", () => {
    expect(clinicDateOptions([noonUtc("2026-06-10")])[0].label).toBe("Wed, Jun 10");
  });

  it("returns an empty list for an empty calendar", () => {
    expect(clinicDateOptions([])).toEqual([]);
  });

  it("does not mutate the caller's array", () => {
    const input = [noonUtc("2026-06-20"), noonUtc("2026-06-06")];
    clinicDateOptions(input);
    expect(input.map((d) => d.toISOString())).toEqual([
      "2026-06-20T12:00:00.000Z",
      "2026-06-06T12:00:00.000Z",
    ]);
  });
});

/** Minimal structural stand-in for a loaded FormSection + FormField rows. */
const field = (key: string, options: unknown = null) => ({ key, options });
const section = (title: string, fields: ReturnType<typeof field>[]) => ({ title, fields });

describe("resolveAvailabilityOptions", () => {
  const dates = [new Date("2026-06-06T12:00:00.000Z"), new Date("2026-06-13T12:00:00.000Z")];

  it("replaces the availability field's stored options with the live calendar", () => {
    const stale = [{ value: "2026-05-30", label: "May 30" }];
    const out = resolveAvailabilityOptions(
      [section("Availability", [field(AVAILABILITY_FIELD_KEY, stale)])],
      dates,
    );
    expect(out[0].fields[0].options).toEqual([
      { value: "2026-06-06", label: "Sat, Jun 6" },
      { value: "2026-06-13", label: "Sat, Jun 13" },
    ]);
  });

  it("leaves sections without an availability field untouched", () => {
    const other = [section("Languages", [field("spanish_proficiency", [{ value: "a", label: "A" }])])];
    expect(resolveAvailabilityOptions(other, dates)).toEqual(other);
  });

  it("is a no-op for a cycle with no availability field", () => {
    const only = [section("Personal details", [field("first_name")])];
    expect(resolveAvailabilityOptions(only, [])).toEqual(only);
  });

  it("drops the availability field when the calendar is empty", () => {
    const out = resolveAvailabilityOptions(
      [section("Availability", [field(AVAILABILITY_FIELD_KEY), field("notes")])],
      [],
    );
    expect(out).toHaveLength(1);
    expect(out[0].fields.map((f) => f.key)).toEqual(["notes"]);
  });

  it("drops the whole section when the empty calendar leaves it with no fields", () => {
    const out = resolveAvailabilityOptions(
      [section("Personal details", [field("first_name")]), section("Availability", [field(AVAILABILITY_FIELD_KEY)])],
      [],
    );
    expect(out.map((s) => s.title)).toEqual(["Personal details"]);
  });

  it("does not mutate the sections it is given", () => {
    const input = [section("Availability", [field(AVAILABILITY_FIELD_KEY, null)])];
    resolveAvailabilityOptions(input, dates);
    expect(input[0].fields[0].options).toBeNull();
  });
});
