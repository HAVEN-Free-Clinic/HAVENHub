// @vitest-environment jsdom
/**
 * Audit 14 (UI-3): the speed modals checked the `{ error }` a server action returns
 * for a handled failure, but nothing at all for a REJECTED one. A Prisma failure, a
 * permission check that throws, or a dropped request landed as an unhandled rejection
 * inside the transition body: no Alert rendered, the spinner just went away, and the
 * queue advanced past the applicant as if the routing had been recorded. The lead's
 * decision was gone and nothing on screen said so.
 *
 * These tests drive the real modal, because the defect was in the seam between the
 * component and the action, not in either one alone.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SpeedRouteModal } from "./speed-route-modal";
import { ACTION_REJECTED_MESSAGE } from "@/platform/ui/run-action";
import type { SpeedRouteRow } from "@/modules/recruitment/services/speed-route";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function row(over: Partial<SpeedRouteRow> = {}): SpeedRouteRow {
  return {
    applicationId: "app1",
    name: "Ada Applicant",
    average: 3,
    scoreCount: 2,
    departmentChoices: ["ITCM"],
    proposedDepartmentCode: "ITCM",
    routedDepartmentCode: null,
    returnedFromDepartmentCode: null,
    returnedReason: null,
    decision: "PENDING",
    stage: "REVIEW" as SpeedRouteRow["stage"],
    acceptanceEmailed: false,
    ...over,
  };
}

let mounted: { container: HTMLDivElement; root: Root } | null = null;

type Handlers = {
  onRoute?: (applicationId: string, departmentCode: string) => Promise<{ error?: string }>;
  onReject?: (applicationId: string) => Promise<{ error?: string }>;
};

function mount({ onRoute, onReject, rows }: Handlers & { rows?: SpeedRouteRow[] }) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <SpeedRouteModal
        open
        onClose={() => {}}
        rows={rows ?? [row(), row({ applicationId: "app2", name: "Bo Applicant" })]}
        departments={["ITCM", "SRHD"]}
        onRoute={onRoute ?? (async () => ({}))}
        onReject={onReject ?? (async () => ({}))}
      />,
    ),
  );
  mounted = { container, root };
}

/** The modal portals to document.body, so queries run against the whole document. */
const buttonNamed = (text: string) =>
  Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === text);
const dialogTitle = () => document.querySelector("h2")?.textContent ?? "";
const alertText = () => document.querySelector('[role="alert"]')?.textContent ?? "";

afterEach(() => {
  if (mounted) {
    const { container, root } = mounted;
    act(() => root.unmount());
    container.remove();
    mounted = null;
  }
  document.body.style.overflow = "";
});

describe("SpeedRouteModal when the route action REJECTS", () => {
  it("surfaces the failure instead of silently swallowing it", async () => {
    mount({
      onRoute: async () => {
        throw new Error("PrismaClientKnownRequestError");
      },
    });

    await act(async () => {
      buttonNamed("1. ITCM")?.click();
    });

    expect(alertText()).toContain(ACTION_REJECTED_MESSAGE);
  });

  it("holds the queue on the same applicant, so the decision is not lost quietly", async () => {
    mount({
      onRoute: async () => {
        throw new Error("network");
      },
    });
    expect(dialogTitle()).toContain("(1 of 2)");

    await act(async () => {
      buttonNamed("1. ITCM")?.click();
    });

    expect(dialogTitle()).toContain("(1 of 2)");
    expect(dialogTitle()).toContain("Ada Applicant");
  });

  it("does the same for a rejected Reject action", async () => {
    mount({
      onReject: async () => {
        throw new Error("boom");
      },
    });

    await act(async () => {
      buttonNamed("Reject (R)")?.click();
    });

    expect(alertText()).toContain(ACTION_REJECTED_MESSAGE);
    expect(dialogTitle()).toContain("(1 of 2)");
  });
});

describe("SpeedRouteModal for an applicant a department handed back", () => {
  /**
   * Audit 14 (REC-2): a returned applicant is PENDING with no routed department,
   * so they queue in the middle tier like anyone else -- and their first ranked
   * choice, which the "1" key routes to, is usually the department that just
   * declined them. The modal offered it, and the lead re-queued them there with
   * one keystroke.
   */
  const returned = [
    row({
      departmentChoices: ["ITCM", "SRHD"],
      returnedFromDepartmentCode: "ITCM",
      returnedReason: "not a fit for us",
      proposedDepartmentCode: null,
    }),
  ];

  it("does not offer the declining department as a ranked target", () => {
    mount({ rows: returned });
    expect(buttonNamed("1. ITCM")).toBeUndefined();
    expect(buttonNamed("1. SRHD")).toBeDefined();
  });

  it("routes the number key to the next department, never back to the decliner", async () => {
    const routed: string[] = [];
    mount({ rows: returned, onRoute: async (_id, dept) => { routed.push(dept); return {}; } });

    await act(async () => {
      buttonNamed("1. SRHD")?.click();
    });

    expect(routed).toEqual(["SRHD"]);
  });
});

describe("SpeedRouteModal when the route action succeeds or fails cleanly", () => {
  it("advances on success", async () => {
    mount({});
    await act(async () => {
      buttonNamed("1. ITCM")?.click();
    });
    expect(dialogTitle()).toContain("Bo Applicant");
  });

  it("still shows a HANDLED {error} verbatim, not the generic fallback", async () => {
    mount({ onRoute: async () => ({ error: "That department is full." }) });

    await act(async () => {
      buttonNamed("1. ITCM")?.click();
    });

    expect(alertText()).toContain("That department is full.");
    expect(alertText()).not.toContain(ACTION_REJECTED_MESSAGE);
  });
});
