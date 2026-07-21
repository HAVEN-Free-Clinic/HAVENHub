import { describe, it, expect } from "vitest";
import { clinicDateOptions } from "./clinic-dates";

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
