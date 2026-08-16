import { describe, expect, it } from "vitest";
import { normaliseLabel, parseTermSchedule, splitNames } from "./schedule";

/** The real sheet's header, including the twice-repeated 9am-12pm column. */
const HEADER = [
  "",
  "On-Call Attending for the week leading up to the NEXT clinic day",
  "Attending 9am-12pm",
  "Attending 9am-12pm",
  "Attending 11am-2pm",
  "Shadowing",
  "RHD Attending",
  "Specialty Clinic",
  "BHD Clinic",
];

function sheet(...rows: unknown[][]) {
  // The real workbook carries a stray title row above the header.
  return [["∫nmv"], HEADER, ...rows];
}

describe("splitNames", () => {
  it("splits a cell naming two people", () => {
    expect(splitNames("Peggy Bia/Frank Bia")).toEqual(["Peggy Bia", "Frank Bia"]);
  });

  it("strips a parenthetical annotation but keeps the name", () => {
    expect(splitNames("Ana (on call)")).toEqual(["Ana"]);
    expect(splitNames("Michelle Silva (until noon)")).toEqual(["Michelle Silva"]);
  });

  // An asterisk marks a first shift, not part of the name.
  it("strips the first-shift asterisk", () => {
    expect(splitNames("Achong*")).toEqual(["Achong"]);
  });

  /**
   * "N/A" means this column has nobody. Splitting on the slash first would turn
   * it into two bogus names, "N" and "A", which is exactly what happened before
   * the check moved ahead of the split.
   */
  it("reads N/A as nobody rather than two names", () => {
    expect(splitNames("N/A")).toEqual([]);
    expect(splitNames("n/a")).toEqual([]);
  });

  it("ignores an empty cell", () => {
    expect(splitNames("   ")).toEqual([]);
  });
});

describe("normaliseLabel", () => {
  it("matches the sheet's wording to the hub's column labels", () => {
    expect(normaliseLabel("Attending 9am-12pm")).toBe(normaliseLabel("9am-12pm"));
    expect(normaliseLabel("RHD Attending")).toBe(normaliseLabel("RHD"));
    expect(normaliseLabel("BHD Clinic")).toBe(normaliseLabel("bhd  clinic"));
  });

  it("keeps genuinely different columns apart", () => {
    expect(normaliseLabel("Attending 9am-12pm")).not.toBe(normaliseLabel("Attending 11am-2pm"));
  });
});

describe("parseTermSchedule", () => {
  it("resolves a date from the month row above the day row", () => {
    const parse = parseTermSchedule(sheet(["June"], ["6"], ["13"]), { startYear: 2026 });
    expect(parse.rows.map((r) => r.dateKey)).toEqual(["2026-06-06", "2026-06-13"]);
  });

  // A term crossing New Year goes back to January, which must advance the year
  // rather than filing the date twelve months early.
  it("advances the year when the months wrap", () => {
    const parse = parseTermSchedule(sheet(["October"], ["3"], ["January"], ["9"]), {
      startYear: 2026,
    });
    expect(parse.rows.map((r) => r.dateKey)).toEqual(["2026-10-03", "2027-01-09"]);
  });

  /**
   * The sheet repeats "Attending 9am-12pm" as two columns, which is how it
   * expresses two attendings in one window. Both must feed the same slot.
   */
  it("collects both repeated columns into one slot", () => {
    const parse = parseTermSchedule(
      sheet(["June"], ["20", "Peggy Bia", "Peggy Bia", "Frank Bia", "Marc Mann"]),
      { startYear: 2026 },
    );
    expect(parse.rows[0].bySlotLabel["Attending 9am-12pm"]).toEqual(["Peggy Bia", "Frank Bia"]);
    expect(parse.rows[0].bySlotLabel["Attending 11am-2pm"]).toEqual(["Marc Mann"]);
  });

  // On-call covers the week AFTER this date, so it is a property of the row
  // rather than one of the day's slots.
  it("reads on-call and the specialty clinic as row properties, not slots", () => {
    const parse = parseTermSchedule(
      sheet(["June"], ["6", "Elizabeth Roessler", "", "", "", "", "", "Derm"]),
      { startYear: 2026 },
    );
    expect(parse.rows[0].onCallText).toBe("Elizabeth Roessler");
    expect(parse.rows[0].specialtyText).toBe("Derm");
    expect(parse.rows[0].bySlotLabel).toEqual({});
  });

  it("marks a closed day from a marker in any column", () => {
    const parse = parseTermSchedule(
      sheet(["July"], ["4", "Jack Peng", "(HAVEN FREE CLINIC CLOSED)"]),
      { startYear: 2026 },
    );
    expect(parse.rows[0].isClosed).toBe(true);
    expect(parse.rows[0].closedNote).toBe("HAVEN FREE CLINIC CLOSED");
    // The on-call attending still stands: someone carries the pager that week
    // even when the clinic itself does not run.
    expect(parse.rows[0].onCallText).toBe("Jack Peng");
  });

  it("ignores rows before a month has been seen", () => {
    const parse = parseTermSchedule(sheet(["6", "Someone"], ["June"], ["13"]), { startYear: 2026 });
    expect(parse.rows.map((r) => r.dateKey)).toEqual(["2026-06-13"]);
  });

  it("ignores a trailing notes row that is not a date", () => {
    const parse = parseTermSchedule(
      sheet(["June"], ["6"], ["*First shift"], ["Confirmed able to sign GAC"]),
      { startYear: 2026 },
    );
    expect(parse.rows).toHaveLength(1);
  });

  it("returns nothing when the sheet has no recognisable header", () => {
    expect(parseTermSchedule([["a", "b"], ["1", "2"]], { startYear: 2026 }).rows).toEqual([]);
  });
});
