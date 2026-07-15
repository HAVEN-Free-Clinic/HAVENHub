export type Decision = "PENDING" | "ACCEPT" | "REJECT" | "WAITLIST";

export type RosterDecisionStatus = "ACCEPTED" | "WAITLIST" | "REJECTED" | "NONE";

export type RosterDecision = {
  status: RosterDecisionStatus;
  label: string;
  tone: "default" | "success" | "warning" | "critical";
  departments: string[];
};

/** The applicant roster's single "Decision" signal, derived from every place a
 *  decision can live: acceptances (director- or volunteer-track ACCEPT mints
 *  one), the volunteer-track `Application.decision`, and each `Interview.decision`.
 *  Precedence is accepted > waitlisted > rejected > none: an acceptance is the
 *  strongest outcome, and a waitlist is more actionable than a rejection. This
 *  is why a waitlisted applicant no longer reads "None" (which happens when the
 *  column reads only acceptances) or "Decided" (the collapsed pipeline stage). */
export function rosterDecision(input: {
  acceptances: { departmentCode: string }[];
  applicationDecision: Decision;
  interviews: { decision: Decision }[];
}): RosterDecision {
  if (input.acceptances.length > 0) {
    const departments = [...new Set(input.acceptances.map((a) => a.departmentCode))];
    return departments.length > 1
      ? { status: "ACCEPTED", label: `Conflict: ${departments.join(" + ")}`, tone: "critical", departments }
      : { status: "ACCEPTED", label: `Accepted: ${departments[0]}`, tone: "success", departments };
  }
  const decisions = [input.applicationDecision, ...input.interviews.map((i) => i.decision)];
  if (decisions.includes("WAITLIST")) return { status: "WAITLIST", label: "Waitlisted", tone: "warning", departments: [] };
  if (decisions.includes("REJECT")) return { status: "REJECTED", label: "Rejected", tone: "default", departments: [] };
  return { status: "NONE", label: "None", tone: "default", departments: [] };
}
