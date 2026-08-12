import { z } from "zod";
import { getOnboardingStatus, type OnboardingTask } from "@/modules/onboarding/services/onboarding";
import { isSatisfied } from "@/modules/onboarding/engine/status";
import { listMyCertificates } from "@/modules/my-info/services/my-info";
import { certExpiresAt } from "@/platform/compliance/rules";
import { formatCalendarDate } from "@/platform/dates";
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
  const completionDate = certs[0]?.completionDate ?? null;
  if (!completionDate) return base; // no certificate on file at all; the generic copy above already covers this

  // completionDate, like clinicDate, is normalized to a fixed UTC instant for a
  // calendar day (noon UTC -- see completion-date.ts) rather than a true event
  // instant, so its expiry renders with formatCalendarDate (UTC), the same
  // choice myNextShiftTool makes for clinicDate. A zoned formatter could shift
  // the rendered day by one.
  return `${base} It expired on ${formatCalendarDate(certExpiresAt(completionDate))}.`;
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
      return "You are cleared to work at clinic this term.";
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
