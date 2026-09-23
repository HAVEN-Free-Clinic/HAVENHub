import { z } from "zod";
import { getOnboardingStatus, type OnboardingTask } from "@/modules/onboarding/services/onboarding";
import { isSatisfied } from "@/modules/onboarding/engine/status";
import { listMyCertificates } from "@/modules/my-info/services/my-info";
import { certExpiresAt } from "@/platform/compliance/rules";
import { formatCalendarDate } from "@/platform/dates";
import { prisma } from "@/platform/db";
import { getAccessTerm } from "@/platform/terms/access-term";
import { epicRequirementFor, strictestEpicRequirement } from "@/modules/recruitment/contract/epic-requirement";
import type { McpTool } from "./index";

/**
 * Renders one outstanding onboarding task as a member-facing clause, reusing
 * the exact label/description the /get-started checklist shows for that task
 * (including any per-term admin override -- see step-config.ts) so Fin's
 * wording can never drift from the in-app checklist for the same term.
 *
 * HIPAA gets one extra clause when the INCOMPLETE reason is specifically an
 * expired certificate rather than no certificate at all: the expiry date.
 * That is safe to read off the newest certificate alone -- unlike the
 * COMPLIANT/EXPIRING_SOON (cleared) case, an INCOMPLETE hipaa status never
 * falls back to an older certificate (see effectiveComplianceStatus: the
 * fallback only triggers for PENDING_VERIFICATION/UNKNOWN_DATE), so the
 * newest row is guaranteed to be the one the status was actually computed
 * from. Deliberately NOT extended to the cleared/COMPLETE case for the same
 * reason: there the fallback can point at an older certificate, and guessing
 * wrong there would tell a member their cert is valid through the wrong date.
 */
async function describeOutstandingTask(personId: string, task: OnboardingTask): Promise<string> {
  const base = `${task.label}: ${task.description}`;
  if (task.key !== "hipaa" || task.state !== "INCOMPLETE") return base;

  const certs = await listMyCertificates(personId);
  const newest = certs[0] ?? null;
  // A REJECTED certificate is also INCOMPLETE, and it carries a parsed
  // completionDate, so without this guard Fin would answer "it expired on
  // <date>" about a file the clinic refused -- sending the member off to renew
  // training when what they actually need is to upload the right document. The
  // generic task copy already covers them correctly.
  if (!newest || newest.rejectedAt !== null) return base;
  const completionDate = newest.completionDate ?? null;
  if (!completionDate) return base; // no certificate on file at all; the generic copy above already covers this

  // completionDate, like clinicDate, is normalized to a fixed UTC instant for a
  // calendar day (noon UTC -- see completion-date.ts) rather than a true event
  // instant, so its expiry renders with formatCalendarDate (UTC), the same
  // choice myNextShiftTool makes for clinicDate. A zoned formatter could shift
  // the rendered day by one.
  return `${base} It expired on ${formatCalendarDate(certExpiresAt(completionDate))}.`;
}

/**
 * Sentence appended to a "cleared" answer for a member who needs Epic and does
 * not have an account on file yet. Clinic clearance (getOnboardingStatus:
 * profile, HIPAA, training, learning, EHS) never covers Epic at all, so
 * "you are cleared" alone is misleading for anyone who still cannot open a
 * patient chart. Only ever appended, never the whole answer -- see
 * myClearanceStatusTool's run() for why this must not touch the `cleared`
 * boolean or the branch structure.
 */
const EPIC_ADVISORY =
  "Clinic clearance does not cover Epic access, and you do not have an Epic account on file yet. Ask about your Epic status, or check the Hub, for next steps.";

/**
 * Whether the cleared answer above needs EPIC_ADVISORY appended: the member
 * is missing an Epic account on file AND their active-term department(s)
 * definitely require one.
 *
 * "Definitely" is the operative word, and it is the whole reason this function
 * exists rather than inlining a query. epicRequirementFor/strictestEpicRequirement
 * (reused, not re-derived -- see src/modules/recruitment/contract/epic-requirement.ts)
 * resolve each department's requirement to ALL, SOME, or NONE. ALL needs Epic
 * unconditionally, so that alone triggers the advisory. SOME depends on the
 * person -- resolveEpicNeeded consults a self-reported answer that lives on
 * the term's onboarding contract, which is outside what this clearance tool
 * reads -- and NONE never needs it. A SOME department therefore NEVER
 * triggers the advisory here, even though some SOME-department members
 * genuinely do need Epic: guessing wrong in either direction is real harm
 * (a false "you need Epic" sends someone chasing an account they were never
 * meant to have; the task is explicit that omission beats a guess), and a
 * missed advisory for a true SOME case is recoverable the member can still
 * ask my_epic_status or a human, while a fabricated requirement is not.
 *
 * Scoped to the access term (getAccessTerm), the same term
 * computeOnboardingForTerm used to decide `cleared` in the first place, so
 * the advisory can never disagree with what "cleared" was actually computed
 * against.
 */
async function needsEpicAdvisory(personId: string): Promise<boolean> {
  const person = await prisma.person.findUnique({ where: { id: personId }, select: { epicId: true } });
  if (person?.epicId) return false; // already has an account on file; nothing to advise

  const term = await getAccessTerm(personId);
  // Cannot happen in the caller's cleared branch, which only runs once
  // hasActiveTerm has already been confirmed true -- getAccessTerm falls back
  // to the live term itself (see its own doc comment) and so is non-null
  // whenever a live term exists. Failing toward no advisory rather than
  // asserting, for the same reason the "cannot happen" branch above does.
  if (!term) return false;

  const memberships = await prisma.termMembership.findMany({
    where: { personId, termId: term.id, status: "ACTIVE" },
    select: { kind: true, department: { select: { requiresEpicDirector: true, requiresEpicVolunteer: true } } },
  });

  const requirement = strictestEpicRequirement(memberships.map((m) => epicRequirementFor(m.department, m.kind)));
  return requirement === "ALL";
}

/**
 * "Am I cleared for the term?" -- the highest-value compliance question a
 * member asks, because it decides whether they can be scheduled at all.
 *
 * Deliberately reuses getOnboardingStatus, the exact function the dashboard's
 * "Cleared" / "Not yet cleared" badge (src/app/(app)/page.tsx) and the
 * /get-started hard gate (enforceOnboarding) both read. Assembling a second
 * "cleared" answer from overallClearance/complianceStatus directly here would
 * risk disagreeing with the dashboard on some edge case it already handles
 * (a disabled step, a per-term override, non-blocking EHS, an exempt role) --
 * a member being told two different answers by the dashboard and by Fin is
 * exactly the failure this tool exists to avoid, not a hypothetical one.
 */
export const myClearanceStatusTool: McpTool = {
  name: "my_clearance_status",
  title: "My clearance status",
  description:
    "Whether the signed-in member is cleared to work at clinic this term, and if not, exactly what is outstanding. Use for questions like 'am I cleared?', 'why can't I sign up for a shift?', or 'what do I still need to finish?'.",
  inputSchema: z.object({}),
  run: async (ctx) => {
    const status = await getOnboardingStatus(ctx.personId);

    if (!status.hasActiveTerm) {
      return "There is no active clinic term right now, so clearance does not apply.";
    }

    if (status.cleared) {
      const clearedText = "You are cleared to work at clinic this term.";
      // Appended to the TEXT only -- `cleared` and the branch above are
      // untouched. See EPIC_ADVISORY and needsEpicAdvisory's doc comments for
      // why this never fires for the not-cleared branch and never guesses at
      // a SOME department.
      const needsAdvisory = await needsEpicAdvisory(ctx.personId);
      return needsAdvisory ? `${clearedText} ${EPIC_ADVISORY}` : clearedText;
    }

    // isSatisfied(state) is COMPLETE or NOT_REQUIRED; anything else is what is
    // actually blocking them, and naming it is the whole point of this tool --
    // "you are not cleared" alone is the useless answer it exists to avoid.
    const outstanding = status.tasks.filter((t) => !isSatisfied(t.state));
    if (outstanding.length === 0) {
      // Cannot happen -- `cleared` is derived from these same tasks via
      // computeGating -- but fail toward an honest, generic answer rather than
      // an empty outstanding list if that invariant is ever violated.
      return "You are not yet cleared for the term, but nothing specific is outstanding right now. Please contact a human on the team.";
    }

    const items = await Promise.all(outstanding.map((t) => describeOutstandingTask(ctx.personId, t)));
    return `You are not yet cleared for the term. Outstanding: ${items.join(" ")}`;
  },
};
