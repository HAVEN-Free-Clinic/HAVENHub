import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BuilderGrid } from "./builder-grid";
import type {
  BuilderMember,
  BuilderAssignmentEntry,
} from "@/modules/schedule/services/builder";

/** Noon-UTC anchored calendar date, matching how the schema stores clinicDate. */
function d(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
}

const member: BuilderMember = {
  membershipId: "mem-1",
  person: { id: "p1", name: "Alice Volunteer", verifiedLanguages: [], licensedRN: false },
  kind: "VOLUNTEER",
  availability: { tier: "SELF", dates: [] },
  overrideActive: false,
  acknowledgePending: false,
  legacyNote: null,
  intake: { minShiftsWanted: null, additionalShiftAvailability: null, feedback: null },
};

const NO_TAGS = {
  triage: false,
  walkin: false,
  cc: false,
  remote: false,
  specialty: false,
};

function assignment(
  role: BuilderAssignmentEntry["role"],
  tags: Partial<typeof NO_TAGS> = {},
): BuilderAssignmentEntry {
  return {
    role,
    tags: { ...NO_TAGS, ...tags },
    person: { name: "Alice Volunteer", verifiedLanguages: [], licensedRN: false },
  };
}

function renderGrid(
  clinicDates: Date[],
  closedDateKeys: string[] = [],
  opts: {
    assignmentsByDate?: Record<string, Record<string, BuilderAssignmentEntry>>;
    deptCode?: string;
    mode?: "assign" | "shadow";
  } = {},
) {
  return renderToStaticMarkup(
    <BuilderGrid
      members={[member]}
      clinicDates={clinicDates}
      assignmentsByDate={opts.assignmentsByDate ?? {}}
      highlightDateKey={null}
      closedDateKeys={closedDateKeys}
      deptId="d1"
      deptCode={opts.deptCode ?? "MED"}
      mode={opts.mode ?? "assign"}
      assignAction={async () => {}}
      unassignAction={async () => {}}
    />,
  );
}

describe("BuilderGrid", () => {
  // A closed Saturday is labelled, not withheld: a department can still be
  // scheduled onto one to cover triage, so the column stays and says so.
  it("marks a closed date's column while keeping every column", () => {
    const dates = [d(2026, 8, 7), d(2026, 9, 12)];
    const out = renderGrid(dates, ["2026-08-07"]);
    expect(out).toContain("August 7th");
    expect(out).toContain("September 12th");
    expect(out).toContain("Closed");
    // One closed date, one marker: the open column must not pick it up too.
    expect(out.split("Closed").length - 1).toBe(1);
  });

  it("marks nothing when no date is closed", () => {
    const out = renderGrid([d(2026, 8, 7)]);
    expect(out).not.toContain("Closed");
  });

  it("renders header date columns chronologically even when clinicDates arrives out of order", () => {
    // Mirrors a real Term.clinicDates array: Postgres gives no ordering
    // guarantee, and the check-in feature's seed appends today's date to the
    // end regardless of where it falls chronologically.
    const outOfOrder = [d(2026, 9, 12), d(2026, 9, 26), d(2026, 8, 7)];
    const out = renderGrid(outOfOrder);
    // displayDate renders "August 7th" / "September 12th" / "September 26th"
    // with no year, which is unique enough within this single-year fixture.
    const augustIdx = out.indexOf("August 7th");
    const sept12Idx = out.indexOf("September 12th");
    const sept26Idx = out.indexOf("September 26th");
    expect(augustIdx).toBeGreaterThan(-1);
    expect(sept12Idx).toBeGreaterThan(-1);
    expect(sept26Idx).toBeGreaterThan(-1);
    // Chronological: August 7 must render before both September columns even
    // though it arrives last in the (unsorted) input array.
    expect(augustIdx).toBeLessThan(sept12Idx);
    expect(sept12Idx).toBeLessThan(sept26Idx);
  });

  it("renders body cells in the same chronological column order as the header", () => {
    const outOfOrder = [d(2026, 9, 12), d(2026, 9, 26), d(2026, 8, 7)];
    const out = renderGrid(outOfOrder);
    // Each empty grid cell carries its column's date as a hidden "dateKey"
    // input, so the cell order can be read off those attribute positions
    // independent of the header row.
    const augustCellIdx = out.indexOf('name="dateKey" value="2026-08-07"');
    const sept12CellIdx = out.indexOf('name="dateKey" value="2026-09-12"');
    const sept26CellIdx = out.indexOf('name="dateKey" value="2026-09-26"');
    expect(augustCellIdx).toBeGreaterThan(-1);
    expect(sept12CellIdx).toBeGreaterThan(-1);
    expect(sept26CellIdx).toBeGreaterThan(-1);
    expect(augustCellIdx).toBeLessThan(sept12CellIdx);
    expect(sept12CellIdx).toBeLessThan(sept26CellIdx);
  });

  it("does not mutate the caller's clinicDates array while sorting a copy for rendering", () => {
    const outOfOrder = [d(2026, 9, 12), d(2026, 9, 26), d(2026, 8, 7)];
    const originalOrder = [...outOfOrder];
    renderGrid(outOfOrder);
    expect(outOfOrder).toEqual(originalOrder);
  });

  // -------------------------------------------------------------------------
  // Colour coding
  // -------------------------------------------------------------------------
  //
  // Directors asked for this outright: every filled cell painted the same slate
  // box with the same faint blue chip, so reading a term for "who is shadowing"
  // or "who is on triage" meant reading eighteen columns of 9px letters.

  describe("colour coding", () => {
    it("gives each role its own tint in the legend, and no two the same", () => {
      const out = renderGrid([d(2026, 8, 7)]);

      // The legend paints all three fills, so one render pins the whole set.
      // Asserted as whole class strings: three roles sharing one tint is the
      // bug, and any substring of a single utility cannot tell them apart.
      expect(out).toContain("border-brand/30 bg-brand-faint text-brand-fg");
      expect(out).toContain("border-warning/45 bg-warning/10 text-warning-foreground");
      expect(out).toContain("border-success/40 bg-success/10 text-success-foreground");
    });

    it("names every glyph and chip it can paint", () => {
      const out = renderGrid([d(2026, 8, 7)], [], { deptCode: "SCTP" });

      expect(out).toContain("Volunteer");
      expect(out).toContain("Shadow");
      expect(out).toContain("Director");
      expect(out).toContain("Triage");
      expect(out).toContain("Walk-in");
      expect(out).toContain("Specialty clinic");
    });

    it("leaves out the tags this department does not use", () => {
      // rolesForDept: SCTP has triage/walk-in, JCTP has care coordinator, and
      // everyone else has neither. Explaining a chip that can never appear is
      // worse than explaining nothing.
      const out = renderGrid([d(2026, 8, 7)], [], { deptCode: "MED" });

      expect(out).toContain("Remote");
      expect(out).not.toContain("Triage");
      expect(out).not.toContain("Care coordinator");
    });

    it("tints a read-only filled cell by its role rather than one neutral grey", () => {
      // A non-shadow assignment in shadow mode is the read-only cell: role
      // changes go through the Day view, so it renders as display, not a form.
      const out = renderGrid([d(2026, 8, 7)], [], {
        mode: "shadow",
        assignmentsByDate: { "2026-08-07": { p1: assignment("VOLUNTEER") } },
      });

      // Anchored on the readout's own wrapper classes, not on the tint alone:
      // the legend above carries every tint, so a bare "text-brand-fg" would
      // pass with the cell left grey.
      expect(out).toContain(
        "rounded-lg border px-1.5 py-0.5 border-brand/30 bg-brand-faint text-brand-fg",
      );
    });

    it("colours each tag chip by its own hue", () => {
      const out = renderGrid([d(2026, 8, 7)], [], {
        deptCode: "SCTP",
        mode: "shadow",
        assignmentsByDate: {
          "2026-08-07": { p1: assignment("VOLUNTEER", { triage: true, remote: true }) },
        },
      });

      // Distinct custom properties, so the two chips in one cell cannot render
      // as the same colour. Asserted as the whole style string: the hue and its
      // tint have to come from the same tag or a chip reads as another tag.
      expect(out).toContain("color:var(--tag-triage);background:var(--tag-triage-bg)");
      expect(out).toContain("color:var(--tag-remote);background:var(--tag-remote-bg)");
      // Only the tags actually set are chips. (The legend names walk-in too,
      // which is why this asserts on the cell's own aria-label and not on the
      // custom property, which the legend also carries.)
      expect(out).not.toContain('aria-label="walkin"');
    });

    it("tints an interactive filled cell by its role too", () => {
      // The common case: a volunteer cell in assign mode is a form, not a
      // readout, and it is the one every director stares at all term.
      const out = renderGrid([d(2026, 8, 7)], [], {
        assignmentsByDate: { "2026-08-07": { p1: assignment("SHADOW") } },
      });

      // The trailing hover state belongs to the cell button alone, so this
      // cannot be satisfied by the legend's copy of the same tint.
      expect(out).toContain(
        "border-warning/45 bg-warning/10 text-warning-foreground hover:border-critical/30",
      );
    });

    it("keeps the letter on every cell, so the colour is never the only channel", () => {
      const out = renderGrid([d(2026, 8, 7)], [], {
        deptCode: "SCTP",
        mode: "shadow",
        assignmentsByDate: {
          "2026-08-07": { p1: assignment("VOLUNTEER", { triage: true }) },
        },
      });

      // WCAG 1.4.1: the glyph and the chip code carry the meaning; hue is the
      // scanning aid on top of them.
      expect(out).toContain(">V<");
      expect(out).toContain(">T<");
    });
  });
});
