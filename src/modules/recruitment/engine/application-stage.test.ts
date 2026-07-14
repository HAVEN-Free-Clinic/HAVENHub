import { expect, it } from "vitest";
import { applicationStage } from "./application-stage";

it("is AWAITING_SCORING with no scores, no routing, no interviews", () => {
  expect(applicationStage({ scoreCount: 0, routedDepartmentCode: null, interviews: [] })).toBe("AWAITING_SCORING");
});
it("is SCORING once a score exists but not routed", () => {
  expect(applicationStage({ scoreCount: 2, routedDepartmentCode: null, interviews: [] })).toBe("SCORING");
});
it("is ROUTED once routed with no interview", () => {
  expect(applicationStage({ scoreCount: 2, routedDepartmentCode: "EDUC", interviews: [] })).toBe("ROUTED");
});
it("is INTERVIEWING once an interview exists but is undecided", () => {
  expect(applicationStage({ scoreCount: 2, routedDepartmentCode: "EDUC", interviews: [{ decision: "PENDING" }] })).toBe("INTERVIEWING");
});
it("is DECIDED once any interview has a non-pending decision", () => {
  expect(applicationStage({ scoreCount: 2, routedDepartmentCode: "EDUC", interviews: [{ decision: "ACCEPT" }] })).toBe("DECIDED");
});
