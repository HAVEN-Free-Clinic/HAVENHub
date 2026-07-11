import { describe, expect, it } from "vitest";
import { trackerStageFor } from "./portal-tracker";

const statusOf = (nodeStatuses: string[]) => nodeStatuses.join(",");

describe("trackerStageFor", () => {
  it("DRAFT hides the tracker", () => {
    const s = trackerStageFor("DRAFT");
    expect(s.showTracker).toBe(false);
    expect(s.terminal).toBeNull();
  });

  it("SUBMITTED marks Submitted done and In review current", () => {
    const s = trackerStageFor("SUBMITTED");
    expect(s.showTracker).toBe(true);
    expect(s.nodes.map((n) => n.key)).toEqual(["submitted", "in_review", "interview", "decision"]);
    expect(statusOf(s.nodes.map((n) => n.status))).toBe("done,current,upcoming,upcoming");
    expect(s.terminal).toBeNull();
  });

  it("INTERVIEW marks Interview current", () => {
    const s = trackerStageFor("INTERVIEW");
    expect(statusOf(s.nodes.map((n) => n.status))).toBe("done,done,current,upcoming");
  });

  it("ACCEPTED completes all nodes and flags accepted", () => {
    const s = trackerStageFor("ACCEPTED");
    expect(statusOf(s.nodes.map((n) => n.status))).toBe("done,done,done,done");
    expect(s.terminal).toBe("accepted");
  });

  it("ONBOARDING completes all nodes and flags accepted", () => {
    const s = trackerStageFor("ONBOARDING");
    expect(statusOf(s.nodes.map((n) => n.status))).toBe("done,done,done,done");
    expect(s.terminal).toBe("accepted");
  });

  it("WAITLISTED completes through Interview, Decision current, flagged waitlisted", () => {
    const s = trackerStageFor("WAITLISTED");
    expect(statusOf(s.nodes.map((n) => n.status))).toBe("done,done,done,current");
    expect(s.terminal).toBe("waitlisted");
  });

  it("NOT_SELECTED marks Decision done and flags not_selected", () => {
    const s = trackerStageFor("NOT_SELECTED");
    expect(statusOf(s.nodes.map((n) => n.status))).toBe("done,done,done,done");
    expect(s.terminal).toBe("not_selected");
  });
});
