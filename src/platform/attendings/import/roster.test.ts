import { describe, expect, it } from "vitest";
import { deriveScheduleName, parseAttendingRoster, specialtyCodeFor } from "./roster";

const HEADER = [
  "Current Attendings",
  "Credentials",
  "Specialty",
  "Email Address",
  "Phone Number",
  "Notes",
];

function sheet(...rows: unknown[][]) {
  return [HEADER, ...rows];
}

describe("deriveScheduleName", () => {
  it("turns 'Last, First' into the name the schedule uses", () => {
    expect(deriveScheduleName("Bia, Frank")).toBe("Frank Bia");
    expect(deriveScheduleName("Marshall, Ami")).toBe("Ami Marshall");
  });

  // The contact sheet records the legal given name with the everyday one in
  // parentheses, while the schedule uses only the everyday one.
  it("prefers a parenthetical nickname, which is what the schedule writes", () => {
    expect(deriveScheduleName("Peng, Bo (Jack)")).toBe("Jack Peng");
    expect(deriveScheduleName("Hughes, John (Jack)")).toBe("Jack Hughes");
    expect(deriveScheduleName("Qiu, Xiaoliang (Shawn)")).toBe("Shawn Qiu");
  });

  it("leaves an already-forename-first name alone", () => {
    expect(deriveScheduleName("Madeline Wilson")).toBe("Madeline Wilson");
    expect(deriveScheduleName("Daniel Guevara-Pineda")).toBe("Daniel Guevara-Pineda");
  });

  it("keeps a single-word name as-is rather than inventing a surname", () => {
    expect(deriveScheduleName("Ami")).toBe("Ami");
  });

  it("collapses stray whitespace", () => {
    expect(deriveScheduleName("  Bia,   Margaret ")).toBe("Margaret Bia");
  });
});

describe("confirmed schedule names", () => {
  /**
   * These are everyday names with no mechanical relationship to the formal one,
   * so no derivation rule could reach them. Each was confirmed by Faculty
   * Relations; the import would otherwise leave their shifts unassigned.
   */
  it("uses the confirmed name over the derived one", () => {
    const parse = parseAttendingRoster(
      sheet(
        ["Bia, Margaret", "MD", "Primary Care"],
        ["Atlas, Stephen", "MD", "Primary Care"],
        ["Kang, Angela", "MD, MPH", "Primary Care"],
        ["Madeline Wilson", "MD", "Primary Care"],
        ["Wormser, Andrew", "MD", "Primary Care"],
        ["Ponce Terashima, Javier", "MD", "BHD"],
      ),
    );

    expect(parse.attendings.map((a) => a.scheduleName)).toEqual([
      "Peggy Bia",
      "Steve Atlas",
      "Angi Kang",
      "Maddie Wilson",
      "Andy Wormser",
      "Dr. Ponce",
    ]);
  });

  // Frank is derived normally; only Margaret is overridden. Getting this wrong
  // would collapse two real physicians onto one name.
  it("leaves the other Bia alone", () => {
    const parse = parseAttendingRoster(sheet(["Bia, Frank", "MD, MPH", "Primary Care"]));
    expect(parse.attendings[0].scheduleName).toBe("Frank Bia");
  });

  it("keeps the formal name as fullName", () => {
    const parse = parseAttendingRoster(sheet(["Bia, Margaret", "MD", "Primary Care"]));
    expect(parse.attendings[0].fullName).toBe("Bia, Margaret");
  });
});

describe("specialtyCodeFor", () => {
  it("maps the sheet's wording onto specialty codes", () => {
    expect(specialtyCodeFor("Primary Care")).toBe("PC");
    expect(specialtyCodeFor("RHD")).toBe("RHD");
    expect(specialtyCodeFor("BHD")).toBe("BHD");
    expect(specialtyCodeFor("Dermatology")).toBe("DERM");
    expect(specialtyCodeFor("Neurology")).toBe("NEURO");
    // The sheet writes "Nephrology Clinic", not "Nephrology".
    expect(specialtyCodeFor("Nephrology Clinic")).toBe("NEPHRO");
  });

  it("reports an unrecognised specialty rather than guessing", () => {
    expect(specialtyCodeFor("Cardiology")).toBeNull();
    expect(specialtyCodeFor(null)).toBeNull();
  });
});

describe("parseAttendingRoster", () => {
  it("reads a row's contact details", () => {
    const parse = parseAttendingRoster(
      sheet(["Bia, Frank", "MD, MPH", "Primary Care", "frank.bia@yale.edu", "2036230944", "note"]),
    );

    expect(parse.attendings).toEqual([
      {
        fullName: "Bia, Frank",
        scheduleName: "Frank Bia",
        credentials: "MD, MPH",
        specialtyText: "Primary Care",
        email: "frank.bia@yale.edu",
        phone: "2036230944",
        notes: "note",
        isActive: true,
      },
    ]);
  });

  // Everything below the section headers is kept, not skipped: the roster is the
  // record of who has ever attended, and a past attending still appears on
  // historical schedules.
  it("marks the removed and past sections inactive rather than dropping them", () => {
    const parse = parseAttendingRoster(
      sheet(
        ["Bia, Frank", "MD", "Primary Care", "f@x.edu", "", ""],
        ["Removed:"],
        ["Mohammad, Amir", "", "Primary Care", "a@x.edu", "", ""],
        ["Past Attendings:"],
        ["Last Name", "First Name"],
        ["Anandan", "Swapna"],
      ),
    );

    expect(parse.attendings.map((a) => [a.scheduleName, a.isActive])).toEqual([
      ["Frank Bia", true],
      ["Amir Mohammad", false],
      ["Swapna Anandan", false],
    ]);
  });

  // The past section is two columns, not one full name.
  it("joins the past section's split name columns", () => {
    const parse = parseAttendingRoster(
      sheet(["Past Attendings:"], ["Last Name", "First Name"], ["Oldfield", "Benjamin"]),
    );
    expect(parse.attendings[0].fullName).toBe("Oldfield, Benjamin");
    expect(parse.attendings[0].scheduleName).toBe("Benjamin Oldfield");
  });

  /**
   * The schedule identifies an attending by schedule name, and the column is
   * unique, so a collision cannot be resolved by picking a winner. This is real:
   * the live sheet lists Amir Mohammad under both "Removed" and "Past".
   */
  it("refuses both rows when two derive the same schedule name", () => {
    const parse = parseAttendingRoster(
      sheet(
        ["Mohammad, Amir", "", "Primary Care", "a@x.edu", "", ""],
        ["Past Attendings:"],
        ["Last Name", "First Name"],
        ["Mohammad", "Amir"],
      ),
    );

    expect(parse.attendings).toEqual([]);
    expect(parse.duplicateScheduleNames).toEqual([
      { scheduleName: "Amir Mohammad", fullNames: ["Mohammad, Amir", "Mohammad, Amir"] },
    ]);
  });

  it("skips blank rows without reporting them as problems", () => {
    const parse = parseAttendingRoster(sheet([], ["", "", ""], ["Bia, Frank", "MD"]));
    expect(parse.attendings).toHaveLength(1);
    expect(parse.skipped).toEqual([]);
  });

  // Column order is read from the sheet's own header, so inserting a column
  // upstream does not silently shift every field by one.
  it("locates columns by header rather than by position", () => {
    const parse = parseAttendingRoster([
      ["Current Attendings", "Specialty", "Credentials", "Email Address"],
      ["Bia, Frank", "Primary Care", "MD, MPH", "frank.bia@yale.edu"],
    ]);

    expect(parse.attendings[0].credentials).toBe("MD, MPH");
    expect(parse.attendings[0].specialtyText).toBe("Primary Care");
    expect(parse.attendings[0].email).toBe("frank.bia@yale.edu");
  });
});
