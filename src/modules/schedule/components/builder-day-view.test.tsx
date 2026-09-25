import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BuilderDayView } from "./builder-day-view";
import type { BoardApi } from "./builder-board";
import type { BuilderAssignmentEntry } from "@/modules/schedule/services/builder";

const DATE_KEY = "2026-10-03";

const NO_TAGS = { triage: false, walkin: false, cc: false, remote: false, specialty: false };

function assignment(
  role: BuilderAssignmentEntry["role"],
  tags: Partial<typeof NO_TAGS> = {},
): BuilderAssignmentEntry {
  return {
    role,
    tags: { ...NO_TAGS, ...tags },
    person: {
      name: "Sam Shadow",
      legalFirstName: "Sam",
      lastName: "Shadow",
      verifiedLanguages: [],
      spanishScore: null,
      licensedRN: false,
    },
  };
}

function stubBoard(entry: BuilderAssignmentEntry, editable = true): BoardApi {
  return {
    assignments: { [DATE_KEY]: { p1: entry } },
    editable,
    isBusy: () => false,
    assign: () => {},
    unassign: () => {},
    toggleTag: () => {},
    error: null,
    dismissError: () => {},
    live: "live",
  };
}

function render(entry: BuilderAssignmentEntry, editable = true) {
  return renderToStaticMarkup(
    <BuilderDayView
      members={[]}
      conflicts={{}}
      banner={[]}
      clearedPersonIds={[]}
      dept={{ id: "d1", code: "SCTP", name: "Screening", minInterpreterScore: null }}
      selectedDateKey={DATE_KEY}
      profilePersonIds={[]}
      board={stubBoard(entry, editable)}
    />,
  );
}

/** The toggle buttons rendered for the one assignee, by label and pressed state. */
function toggles(markup: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of markup.matchAll(/<button[^>]*aria-pressed="(true|false)"[^>]*>([^<]*)<\/button>/g)) {
    out[m[2]] = m[1];
  }
  return out;
}

describe("BuilderDayView shadow cards", () => {
  it("offers a Remote toggle on a shadow, and only that one", () => {
    // SCTP carries triage/walk-in toggles for volunteers; a shadow gets none of them.
    expect(toggles(render(assignment("SHADOW")))).toEqual({ Remote: "false" });
  });

  it("shows a remote shadow as pressed", () => {
    expect(toggles(render(assignment("SHADOW", { remote: true })))).toEqual({ Remote: "true" });
  });

  it("offers no toggle when the board is read-only", () => {
    expect(toggles(render(assignment("SHADOW"), false))).toEqual({});
  });

  it("still offers a volunteer the department's full tag row", () => {
    expect(Object.keys(toggles(render(assignment("VOLUNTEER"))))).toContain("Triage");
  });
});
