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
  provisional: null,
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

/** An accepted applicant whose roster build has not run yet. */
function incomingMember(overrides: {
  id: string;
  name: string;
  placeable: boolean;
  availability?: Date[];
}): BuilderMember {
  return {
    ...member,
    membershipId: null,
    person: { ...member.person, id: overrides.id, name: overrides.name },
    availability: { tier: "BASELINE", dates: overrides.availability ?? [] },
    provisional: {
      acceptanceId: "acc-1",
      stage: "ACCEPTED",
      placeable: overrides.placeable,
    },
  };
}

function renderGrid(
  clinicDates: Date[],
  closedDateKeys: string[] = [],
  opts: {
    assignmentsByDate?: Record<string, Record<string, BuilderAssignmentEntry>>;
    deptCode?: string;
    mode?: "assign" | "shadow";
    members?: BuilderMember[];
  } = {},
) {
  return renderToStaticMarkup(
    <BuilderGrid
      members={opts.members ?? [member]}
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
  //
  // A cell carries two facts, so it uses two channels. The ROLE rings it and
  // letters it; the SPECIAL SHIFT fills it. Most of the assertions below exist
  // to keep those two from collapsing back into one.

  describe("colour coding", () => {
    it("gives each role its own ring in the legend, and no two the same", () => {
      const out = renderGrid([d(2026, 8, 7)]);

      // The legend paints all three, so one render pins the whole set. Asserted
      // as whole class strings: three roles sharing one colour is the bug, and
      // a substring of a single utility cannot tell them apart.
      expect(out).toContain("border-brand/35 text-brand-fg bg-brand-faint");
      expect(out).toContain("border-warning/55 text-warning-foreground bg-warning/10");
      expect(out).toContain("border-success/50 text-success-foreground bg-success/10");
    });

    it("gives each special shift its own fill in the legend", () => {
      const out = renderGrid([d(2026, 8, 7)], [], { deptCode: "SCTP" });

      // Every swatch draws from the tag's own three-step family, so a fill can
      // never end up wearing another tag's hue.
      for (const tag of ["triage", "walkin", "remote", "specialty"]) {
        expect(out).toContain(`background:var(--tag-${tag}-cell)`);
      }
    });

    it("names every colour it can paint, in both channels", () => {
      const out = renderGrid([d(2026, 8, 7)], [], { deptCode: "SCTP" });

      expect(out).toContain("Role (ring)");
      expect(out).toContain("Shift (fill)");
      expect(out).toContain("Volunteer");
      expect(out).toContain("Shadow");
      expect(out).toContain("Director");
      expect(out).toContain("Triage");
      expect(out).toContain("Walk-in");
      expect(out).toContain("Specialty clinic");
    });

    it("leaves out the shifts this department does not run", () => {
      // rolesForDept: SCTP has triage/walk-in, JCTP has care coordinator, and
      // everyone else has neither. Explaining a fill that can never appear is
      // worse than explaining nothing.
      const out = renderGrid([d(2026, 8, 7)], [], { deptCode: "MED" });

      expect(out).toContain("Remote");
      expect(out).not.toContain("Triage");
      expect(out).not.toContain("Care coordinator");
    });

    it("fills an untagged cell with its role's own tint", () => {
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
        "rounded-lg border px-1.5 py-0.5 border-brand/35 text-brand-fg bg-brand-faint",
      );
    });

    it("fills a tagged cell with the SHIFT's colour, not the role's", () => {
      const out = renderGrid([d(2026, 8, 7)], [], {
        deptCode: "SCTP",
        mode: "shadow",
        assignmentsByDate: {
          "2026-08-07": { p1: assignment("VOLUNTEER", { triage: true }) },
        },
      });

      // This is the whole ask: a triage cell reads as triage across the term.
      expect(out).toContain('style="background:var(--tag-triage-cell)"');
      // ...and the role tint is gone from that cell, so the two never layer.
      expect(out).not.toContain(
        "rounded-lg border px-1.5 py-0.5 border-brand/35 text-brand-fg bg-brand-faint",
      );
    });

    it("keeps the role's ring under a shift fill, so a cell still says both", () => {
      // Assign mode for both, so the two renders differ only in the role and
      // take the same (interactive) code path.
      const renders = (["VOLUNTEER", "SHADOW"] as const).map((role) =>
        renderGrid([d(2026, 8, 7)], [], {
          deptCode: "SCTP",
          assignmentsByDate: {
            "2026-08-07": { p1: assignment(role, { triage: true }) },
          },
        }),
      );

      // Same shift, two roles: identical fill, different ring. If the fill ever
      // swallowed the role, these two renders would be indistinguishable.
      expect(renders[0]).toContain('style="background:var(--tag-triage-cell)"');
      expect(renders[1]).toContain('style="background:var(--tag-triage-cell)"');
      // The hover suffix belongs to the cell button, so the legend's copy of
      // these same ring colours cannot satisfy either assertion.
      expect(renders[0]).toContain("border-brand/35 text-brand-fg hover:border-critical/40");
      expect(renders[1]).toContain(
        "border-warning/55 text-warning-foreground hover:border-critical/40",
      );
    });

    it("gives the medical post the fill when a cell carries two shifts", () => {
      const out = renderGrid([d(2026, 8, 7)], [], {
        deptCode: "SCTP",
        mode: "shadow",
        assignmentsByDate: {
          "2026-08-07": { p1: assignment("VOLUNTEER", { triage: true, remote: true }) },
        },
      });

      // Triage outranks remote: the post is what a director scans for, and
      // remote only modifies how it is worked.
      expect(out).toContain('style="background:var(--tag-triage-cell)"');
      expect(out).not.toContain('style="background:var(--tag-remote-cell)"');
      // The loser is not lost -- it still gets its chip.
      expect(out).toContain('aria-label="remote"');
    });

    it("does not let a shift the department cannot see paint the cell", () => {
      // MED runs neither triage nor walk-in, so the legend never explains them.
      // A fill with no key is worse than no fill.
      const out = renderGrid([d(2026, 8, 7)], [], {
        deptCode: "MED",
        mode: "shadow",
        assignmentsByDate: {
          "2026-08-07": { p1: assignment("VOLUNTEER", { triage: true }) },
        },
      });

      expect(out).not.toContain("var(--tag-triage-cell)");
      expect(out).toContain(
        "rounded-lg border px-1.5 py-0.5 border-brand/35 text-brand-fg bg-brand-faint",
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
      // chip step have to come from the same tag or a chip reads as another tag.
      expect(out).toContain("color:var(--tag-triage);background:var(--tag-triage-chip)");
      expect(out).toContain("color:var(--tag-remote);background:var(--tag-remote-chip)");
      // Only the tags actually set are chips. (The legend names walk-in too,
      // which is why this asserts on the cell's own aria-label and not on the
      // custom property, which the legend also carries.)
      expect(out).not.toContain('aria-label="walkin"');
    });

    it("rings an interactive filled cell by its role too", () => {
      // The common case: a cell in assign mode is a form, not a readout, and it
      // is the one every director stares at all term.
      const out = renderGrid([d(2026, 8, 7)], [], {
        assignmentsByDate: { "2026-08-07": { p1: assignment("SHADOW") } },
      });

      // The trailing hover state belongs to the cell button alone, so this
      // cannot be satisfied by the legend's copy of the same colours.
      expect(out).toContain(
        "border-warning/55 text-warning-foreground bg-warning/10 hover:border-critical/40",
      );
    });

    it("fills an interactive cell by its shift as well", () => {
      const out = renderGrid([d(2026, 8, 7)], [], {
        assignmentsByDate: {
          "2026-08-07": { p1: assignment("VOLUNTEER", { remote: true }) },
        },
      });

      expect(out).toContain('style="background:var(--tag-remote-cell)"');
      // The ring survives, and the role's own fill does not also apply.
      expect(out).toContain("border-brand/35 text-brand-fg hover:border-critical/40");
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

describe("BuilderGrid incoming rows", () => {
  const dates = [d(2026, 9, 5)];

  it("offers a cell on an incoming member who has a Hub account", () => {
    const out = renderGrid(dates, [], {
      members: [incomingMember({ id: "p-returner", name: "Rita Returner", placeable: true })],
    });
    expect(out).toContain("Rita Returner");
    expect(out).toContain("Incoming");
    // The row is assignable exactly like a member's: the shift is real and simply
    // stays inert until roster build gives them the membership every outbound
    // path filters on.
    expect(out).toContain('name="personId" value="p-returner"');
  });

  // A first-time applicant has no Person until roster build, and a shift is keyed
  // on one. The grid must not offer a "+" that setAssignment would then refuse.
  it("renders an inert cell for an incoming applicant with no Hub account", () => {
    const out = renderGrid(dates, [], {
      members: [
        incomingMember({ id: "acceptance:acc-1", name: "Nora Newcomer", placeable: false }),
      ],
    });
    expect(out).toContain("Nora Newcomer");
    expect(out).toContain("Incoming");
    expect(out).not.toContain('value="acceptance:acc-1"');
    expect(out).toContain("cannot be scheduled yet");
  });

  it("distinguishes an incoming row from a former member's", () => {
    const out = renderGrid(dates, [], {
      members: [incomingMember({ id: "p-returner", name: "Rita Returner", placeable: true })],
      assignmentsByDate: { "2026-09-05": { "p-gone": assignment("VOLUNTEER") } },
    });
    expect(out).toContain("Incoming");
    expect(out).toContain("Former");
  });

  // The state must not be carried by the chip's colour alone.
  it("names the incoming state in the cell's accessible label", () => {
    const out = renderGrid(dates, [], {
      members: [incomingMember({ id: "p-returner", name: "Rita Returner", placeable: true })],
    });
    expect(out).toContain("incoming");
  });
});
