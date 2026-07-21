import { expect, it } from "vitest";
import { ROSTER_DECISION_ORDER, rosterDecision } from "./decision-summary";

const none = { acceptances: [], applicationDecision: "PENDING" as const, interviews: [] };

it("is NONE when nothing has been decided", () => {
  const d = rosterDecision(none);
  expect(d.status).toBe("NONE");
  expect(d.label).toBe("None");
  expect(d.tone).toBe("default");
});

it("is ACCEPTED with the department when a single acceptance exists", () => {
  const d = rosterDecision({ ...none, acceptances: [{ departmentCode: "EDUC" }] });
  expect(d.status).toBe("ACCEPTED");
  expect(d.label).toBe("Accepted: EDUC");
  expect(d.tone).toBe("success");
  expect(d.departments).toEqual(["EDUC"]);
});

it("is a CONFLICT when more than one distinct department accepted", () => {
  const d = rosterDecision({ ...none, acceptances: [{ departmentCode: "EDUC" }, { departmentCode: "MDIC" }] });
  expect(d.status).toBe("ACCEPTED");
  expect(d.label).toBe("Conflict: EDUC + MDIC");
  expect(d.tone).toBe("critical");
  expect(d.departments).toEqual(["EDUC", "MDIC"]);
});

it("treats duplicate acceptance department codes as a single department", () => {
  const d = rosterDecision({ ...none, acceptances: [{ departmentCode: "EDUC" }, { departmentCode: "EDUC" }] });
  expect(d.status).toBe("ACCEPTED");
  expect(d.label).toBe("Accepted: EDUC");
});

it("is WAITLIST when the volunteer application decision is WAITLIST", () => {
  const d = rosterDecision({ ...none, applicationDecision: "WAITLIST" });
  expect(d.status).toBe("WAITLIST");
  expect(d.label).toBe("Waitlisted");
  expect(d.tone).toBe("warning");
});

it("is WAITLIST when any interview decision is WAITLIST", () => {
  const d = rosterDecision({ ...none, interviews: [{ decision: "WAITLIST" }] });
  expect(d.status).toBe("WAITLIST");
  expect(d.label).toBe("Waitlisted");
});

it("is REJECTED when the application decision is REJECT and nothing stronger applies", () => {
  const d = rosterDecision({ ...none, applicationDecision: "REJECT" });
  expect(d.status).toBe("REJECTED");
  expect(d.label).toBe("Rejected");
  // Rejections read critical (red) on the roster, matching every other recruitment
  // surface, so a rejected badge is not confused with an undecided (NONE) one.
  expect(d.tone).toBe("critical");
});

it("is REJECTED when any interview decision is REJECT", () => {
  const d = rosterDecision({ ...none, interviews: [{ decision: "REJECT" }] });
  expect(d.status).toBe("REJECTED");
});

it("prefers ACCEPTED over a waitlisted interview (an acceptance is the strongest signal)", () => {
  const d = rosterDecision({ acceptances: [{ departmentCode: "EDUC" }], applicationDecision: "PENDING", interviews: [{ decision: "WAITLIST" }] });
  expect(d.status).toBe("ACCEPTED");
});

it("prefers WAITLIST over REJECT when both appear and no acceptance exists", () => {
  const d = rosterDecision({ acceptances: [], applicationDecision: "PENDING", interviews: [{ decision: "WAITLIST" }, { decision: "REJECT" }] });
  expect(d.status).toBe("WAITLIST");
});

it("orders decisions by precedence, strongest outcome first", () => {
  // Matches the precedence the rosterDecision if-chain already implements.
  expect(ROSTER_DECISION_ORDER).toEqual(["ACCEPTED", "WAITLIST", "REJECTED", "NONE"]);
});
