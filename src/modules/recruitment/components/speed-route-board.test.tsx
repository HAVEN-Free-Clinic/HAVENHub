// @vitest-environment jsdom
/**
 * Audit 14 (REC-2): a returned applicant also appears in their score tier (the
 * board says so explicitly), and the tier row's department select listed every
 * cycle department -- including the one that had just declined them, preselected,
 * because the default is their first ranked choice. Two clicks re-queued the
 * applicant at the department that handed them back.
 */
import { afterEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

import { SpeedRouteBoard } from "./speed-route-board";
import type { SpeedRouteBoard as Board, SpeedRouteRow } from "@/modules/recruitment/services/speed-route";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function row(over: Partial<SpeedRouteRow> = {}): SpeedRouteRow {
  return {
    applicationId: "app1",
    name: "Ada Applicant",
    average: 4,
    scoreCount: 2,
    departmentChoices: ["ITCM", "SRHD"],
    proposedDepartmentCode: null,
    routedDepartmentCode: null,
    returnedFromDepartmentCode: "ITCM",
    returnedReason: "not a fit for us",
    decision: "PENDING",
    stage: "RETURNED" as SpeedRouteRow["stage"],
    acceptanceEmailed: false,
    ...over,
  };
}

function board(over: Partial<Board> = {}): Board {
  const r = row();
  return {
    cycleId: "c1",
    title: "Volunteers",
    track: "VOLUNTEER",
    departments: ["ITCM", "SRHD", "PCAR"],
    topPercent: 20,
    bottomPercent: 20,
    top: [r],
    middle: [],
    bottom: [],
    unscored: [],
    returned: [r],
    ...over,
  };
}

let mounted: { container: HTMLDivElement; root: Root } | null = null;

function mount(b: Board) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <SpeedRouteBoard
        board={b}
        onRoute={async () => ({})}
        onReject={async () => ({})}
        onReopen={async () => ({})}
        onApplyTop={async () => ({ applied: 0, skipped: [] })}
        onApplyBottom={async () => ({ applied: 0, skipped: [] })}
      />,
    ),
  );
  mounted = { container, root };
}

afterEach(() => {
  if (mounted) {
    const { container, root } = mounted;
    act(() => root.unmount());
    container.remove();
    mounted = null;
  }
});

/** Option values of the select with the given accessible name. */
function optionsOf(label: string): string[] {
  const select = Array.from(document.querySelectorAll("select")).find(
    (s) => s.getAttribute("aria-label") === label,
  );
  if (!select) throw new Error(`no select labelled ${label}`);
  return Array.from(select.querySelectorAll("option")).map((o) => o.value).filter(Boolean);
}

it("omits the declining department from the tier row's department select", () => {
  mount(board());
  expect(optionsOf("Route Ada Applicant to")).toEqual(["SRHD", "PCAR"]);
  // The Returned card, which has always excluded it, still does.
  expect(optionsOf("Re-route Ada Applicant to")).toEqual(["SRHD", "PCAR"]);
});

it("still offers every department to an applicant nobody handed back", () => {
  const clean = row({ returnedFromDepartmentCode: null, returnedReason: null, stage: "REVIEW" as SpeedRouteRow["stage"] });
  mount(board({ top: [clean], returned: [] }));
  expect(optionsOf("Route Ada Applicant to")).toEqual(["ITCM", "SRHD", "PCAR"]);
});

/** The board's only checkbox: the tier-level "Show handled" toggle. */
function handledToggle(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>('input[type="checkbox"]');
}

/** A row nobody handed back, so the Returned-card behaviour above stays out of these. */
function plain(over: Partial<SpeedRouteRow>): SpeedRouteRow {
  return row({ returnedFromDepartmentCode: null, returnedReason: null, ...over });
}

it("hides finished rows from a tier until Show handled is ticked", () => {
  const pending = plain({ applicationId: "p", name: "Pat Pending", stage: "SCORING" });
  const routed = plain({ applicationId: "r", name: "Rae Routed", routedDepartmentCode: "SRHD", stage: "ROUTED" });
  mount(board({ top: [pending, routed], returned: [] }));

  expect(document.body.textContent).toContain("Pat Pending");
  expect(document.body.textContent).not.toContain("Rae Routed");
  // The tier still names the whole cohort: the thresholds are a percentage OF
  // that number, so it must not appear to shrink as the lead works the tier.
  expect(document.body.textContent).toContain("Top (1 of 2)");

  const toggle = handledToggle()!;
  expect(toggle).not.toBeNull();
  act(() => { toggle.click(); });
  expect(document.body.textContent).toContain("Rae Routed");
  expect(document.body.textContent).toContain("Top (2)");
});

it("says a fully worked tier is handled rather than empty", () => {
  // "None." would read as "nobody scored into the top tier", which is the one
  // thing it does not mean once every row has been routed.
  const routed = plain({ applicationId: "r", name: "Rae Routed", routedDepartmentCode: "SRHD", stage: "ROUTED" });
  mount(board({ top: [routed], middle: [], bottom: [], returned: [] }));
  expect(document.body.textContent).toContain("All 1 handled.");
});

it("keeps a returned applicant visible in their tier: the lead still owes them a decision", () => {
  // RETURNED has been routed once, so a naive "already routed" filter would bury
  // the single most urgent row on the board.
  mount(board({ top: [row()], middle: [], bottom: [], returned: [row()] }));
  expect(document.body.textContent).toContain("Top (1)");
  expect(handledToggle()).toBeNull();
});

it("drops already-routed applicants from the unscored nag", () => {
  // Renewals and auto-route first choices are routed at submission and never
  // scored, so they land in `unscored` with nothing anyone should do about it.
  const renewal = plain({ applicationId: "u1", name: "Ren Newal", average: null, scoreCount: 0, routedDepartmentCode: "SRHD", stage: "ROUTED" });
  const fresh = plain({ applicationId: "u2", name: "Newt Fresh", average: null, scoreCount: 0, stage: "AWAITING_SCORING" });
  mount(board({ top: [], middle: [], bottom: [], returned: [], unscored: [renewal, fresh] }));

  const text = document.body.textContent ?? "";
  expect(text).toContain("Score these before they can be routed: Newt Fresh.");
  expect(text).not.toContain("Ren Newal");
  expect(text).toContain("1 more applicant skipped committee scoring");
  // Nothing in a TIER is handled, so the toggle has nothing to reveal.
  expect(handledToggle()).toBeNull();
});

it("drops the unscored card entirely when every unscored applicant went straight to a department", () => {
  const renewal = plain({ applicationId: "u1", name: "Ren Newal", average: null, scoreCount: 0, routedDepartmentCode: "SRHD", stage: "ROUTED" });
  mount(board({ top: [], middle: [], bottom: [], returned: [], unscored: [renewal] }));
  expect(document.body.textContent).not.toContain("Unscored");
});
