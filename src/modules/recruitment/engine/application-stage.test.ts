import { expect, it } from "vitest";
import { APPLICATION_STAGE_ORDER, applicationStage, applicationStageLabel, isHandledStage } from "./application-stage";

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

it("is RETURNED when a department handed the applicant back and no re-routing has happened", () => {
  expect(
    applicationStage({
      scoreCount: 2,
      routedDepartmentCode: null,
      returnedToRoutingAt: new Date(),
      applicationDecision: "PENDING",
      interviews: [],
    }),
  ).toBe("RETURNED");
});

// routeApplication clears the marker, so the two are never both set in practice.
// This pins the precedence anyway: a re-routed applicant must read as ROUTED,
// never linger in the lead's re-routing bucket after they have dealt with it.
it("is ROUTED, not RETURNED, once re-routed", () => {
  expect(
    applicationStage({
      scoreCount: 2,
      routedDepartmentCode: "MDIC",
      returnedToRoutingAt: new Date(),
      applicationDecision: "PENDING",
      interviews: [],
    }),
  ).toBe("ROUTED");
});

// A return is not a decision. If the lead later rejects them outright, THAT is
// the decision, and it must win over the returned marker.
it("is DECIDED when a returned applicant is subsequently rejected", () => {
  expect(
    applicationStage({
      scoreCount: 2,
      routedDepartmentCode: null,
      returnedToRoutingAt: new Date(),
      applicationDecision: "REJECT",
      interviews: [],
    }),
  ).toBe("DECIDED");
});

it("orders stages along the recruitment pipeline", () => {
  expect(APPLICATION_STAGE_ORDER).toEqual([
    "AWAITING_SCORING",
    "SCORING",
    // A returned application is scored and waiting on the same lead action
    // (routing) that a freshly-scored one is, so it sorts next to that work
    // rather than at the end with DECIDED.
    "RETURNED",
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

it("counts only the stages the committee can no longer affect as handled", () => {
  expect(APPLICATION_STAGE_ORDER.filter(isHandledStage)).toEqual(["ROUTED", "INTERVIEWING", "DECIDED"]);
});

it("leaves RETURNED unhandled: the lead still owes it a routing decision", () => {
  // The one stage that reads like it is finished (it has been routed once) but
  // is the most urgent work on the board. Hiding it would strand the applicant.
  expect(isHandledStage("RETURNED")).toBe(false);
});

it("classifies every stage, so a new one cannot default into being hidden", () => {
  // Drift guard: isHandledStage is written as an allow-list of finished stages,
  // so a stage added later is treated as work to do until someone says otherwise.
  // This asserts the enumeration stays exhaustive rather than that it stays the
  // same -- update the expectation deliberately when a stage is added.
  expect(APPLICATION_STAGE_ORDER.filter((s) => !isHandledStage(s))).toEqual([
    "AWAITING_SCORING",
    "SCORING",
    "RETURNED",
  ]);
});
