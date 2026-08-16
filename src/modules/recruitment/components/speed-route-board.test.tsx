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
