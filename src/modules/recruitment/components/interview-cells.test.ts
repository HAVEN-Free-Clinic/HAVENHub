import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { interviewStatus } from "./interview-cells";

function iv(over: Partial<Parameters<typeof interviewStatus>[0]> = {}) {
  return {
    scheduledAt: null,
    decision: "PENDING" as const,
    application: { status: "SUBMITTED" },
    ...over,
  };
}

/**
 * The regression bar for this change, and the assertion that fails on the tree
 * before it: /recruitment/interviews rendered no interview status at all, so a
 * panelist could not tell a decided assignment from a live one. A grep is what
 * binds the fix to the PAGE. Sharing the helper without wiring the panelist list
 * to it would leave the finding exactly where it was, and every unit test below
 * would still pass.
 *
 * Scoped to src/app because the thing being guarded is which PAGES print the
 * column; test files are excluded for the reason app-shell.importer.test.ts
 * gives, and this file lives outside src/app anyway so it cannot match itself.
 * Probed: adding the badge to a throwaway third page under src/app fails this.
 */
describe("interview lists speak one status vocabulary", () => {
  it("is rendered by both interview lists and nowhere else", () => {
    const out = execSync(
      'grep -rl "InterviewStatusBadge" src/app --exclude="*.test.ts" --exclude="*.test.tsx" || true',
      { encoding: "utf8" },
    ).trim();
    expect(out ? out.split("\n").sort() : []).toEqual([
      "src/app/(app)/recruitment/cycles/[id]/interviews/page.tsx",
      "src/app/(app)/recruitment/interviews/page.tsx",
    ]);
  });

  it("leaves no page-local copy of the status helper behind", () => {
    // The cycle list declared `function status(iv: {...})` privately. If it
    // comes back, the two lists are free to disagree again.
    const out = execSync(
      'grep -rn "^function status(" src/app --exclude="*.test.ts" --exclude="*.test.tsx" || true',
      { encoding: "utf8" },
    ).trim();
    expect(out).toBe("");
  });
});

/**
 * Precedence pins. These are pins on a helper that has just moved, not the proof
 * of the finding: the body is a verbatim move of the cycle list's private
 * `status()`, and a silent tone change here would repaint a page nobody asked to
 * change.
 */
describe("interviewStatus", () => {
  it("puts withdrawal above a recorded decision", () => {
    expect(interviewStatus(iv({ decision: "ACCEPT", application: { status: "WITHDRAWN" } }))).toEqual(
      { label: "Withdrawn", tone: "warning" },
    );
  });

  it("puts a recorded decision above a scheduled time", () => {
    expect(interviewStatus(iv({ decision: "REJECT", scheduledAt: new Date("2026-04-15") }))).toEqual({
      label: "Rejected",
      tone: "critical",
    });
  });

  it("names each decision in the shared vocabulary", () => {
    expect(interviewStatus(iv({ decision: "ACCEPT" }))).toEqual({ label: "Accepted", tone: "success" });
    expect(interviewStatus(iv({ decision: "WAITLIST" }))).toEqual({ label: "Waitlisted", tone: "warning" });
  });

  it("splits an undecided interview by whether it has a time yet", () => {
    expect(interviewStatus(iv({ scheduledAt: new Date("2026-04-15") }))).toEqual({
      label: "Scheduled",
      tone: "brand",
    });
    expect(interviewStatus(iv())).toEqual({ label: "Offered", tone: "default" });
  });
});
