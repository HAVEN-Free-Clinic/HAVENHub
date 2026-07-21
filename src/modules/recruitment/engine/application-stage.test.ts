import { expect, it } from "vitest";
import { APPLICATION_STAGE_ORDER, applicationStage, applicationStageLabel } from "./application-stage";

it("is AWAITING_SCORING with no scores, no routing, no interviews", () => {
  expect(applicationStage({ scoreCount: 0, routedDepartmentCode: null, applicationDecision: "PENDING", interviews: [] })).toBe("AWAITING_SCORING");
});
it("is SCORING once a score exists but not routed", () => {
  expect(applicationStage({ scoreCount: 2, routedDepartmentCode: null, applicationDecision: "PENDING", interviews: [] })).toBe("SCORING");
});
it("is ROUTED once routed with no interview", () => {
  expect(applicationStage({ scoreCount: 2, routedDepartmentCode: "EDUC", applicationDecision: "PENDING", interviews: [] })).toBe("ROUTED");
});
it("is INTERVIEWING once an interview exists but is undecided", () => {
  expect(applicationStage({ scoreCount: 2, routedDepartmentCode: "EDUC", applicationDecision: "PENDING", interviews: [{ decision: "PENDING" }] })).toBe("INTERVIEWING");
});
it("is DECIDED once any interview has a non-pending decision", () => {
  expect(applicationStage({ scoreCount: 2, routedDepartmentCode: "EDUC", applicationDecision: "PENDING", interviews: [{ decision: "ACCEPT" }] })).toBe("DECIDED");
});
it("is DECIDED once the routed department decides a volunteer app directly (no interview)", () => {
  expect(applicationStage({ scoreCount: 2, routedDepartmentCode: "EDUC", applicationDecision: "ACCEPT", interviews: [] })).toBe("DECIDED");
});

it("orders stages along the recruitment pipeline", () => {
  expect(APPLICATION_STAGE_ORDER).toEqual([
    "AWAITING_SCORING",
    "SCORING",
    "ROUTED",
    "INTERVIEWING",
    "DECIDED",
  ]);
});

it("orders every stage that has a label", () => {
  // Drift guard: adding a stage without placing it in the order array would
  // silently drop it to the front of a stage-sorted roster.
  expect([...APPLICATION_STAGE_ORDER].sort()).toEqual(Object.keys(applicationStageLabel).sort());
});
