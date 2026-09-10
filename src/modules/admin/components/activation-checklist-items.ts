import type { ActivationReadiness } from "@/modules/admin/services/term-readiness";
import { CLINIC_DATE_SHORT, formatCalendarDate } from "@/platform/dates";

export type ChecklistItem = {
  key: string;
  tone: "success" | "warning" | "info";
  text: string;
  link?: { href: string; label: string };
};

/** Clinic dates and term bounds are calendar markers, so they render in UTC. */
function day(d: Date): string {
  return formatCalendarDate(d, CLINIC_DATE_SHORT);
}

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The sentences on the activate screen, one per thing the flip will change.
 *
 * Pure, so the wording is testable without rendering: each branch here was a
 * real way the SU26 to FA26 flip could have gone wrong without anyone seeing it
 * coming. A check with nothing to report stays silent unless its all-clear is
 * itself worth knowing (the timing, the offboarding list, and the gate).
 */
export function activationChecklistItems(
  readiness: ActivationReadiness,
  incoming: { id: string; code: string },
  stepLabels: Partial<Record<string, string>>,
): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  const out = readiness.outgoing;

  if (out) {
    const remaining = out.remainingClinicDates.length;
    const nextClinic = out.remainingClinicDates[0];
    if (out.becomes === "PLANNING") {
      const parts = [
        `${out.code} has not ended yet (it ends ${day(out.endDate)}), so activating now moves it back to Planning instead of archiving it.`,
      ];
      if (remaining > 0) {
        parts.push(
          `Its ${count(remaining, "remaining clinic date")} (next ${day(nextClinic)}) will get no shift reminders or check-in links.`,
        );
      }
      if (out.pendingRequests > 0) {
        parts.push(
          `Its ${count(out.pendingRequests, "pending shift request")} will stay open with nowhere to decide ${out.pendingRequests === 1 ? "it" : "them"}.`,
        );
      }
      parts.push("Activating after its last clinic archives it cleanly.");
      items.push({ key: "timing", tone: "warning", text: parts.join(" ") });
    } else if (remaining > 0) {
      items.push({
        key: "timing",
        tone: "warning",
        text: `${out.code} still has a clinic on ${day(nextClinic)}. Activating before it runs stops that day's shift reminders and check-in links.`,
      });
    } else {
      items.push({
        key: "timing",
        tone: "success",
        text:
          `${out.code} has ended and will be archived.` +
          (out.pendingRequests > 0
            ? ` Its ${count(out.pendingRequests, "pending shift request")} will be cancelled.`
            : ""),
      });
    }

    if (out.notContinuing > 0) {
      items.push({
        key: "offboard",
        tone: "warning",
        text: `${count(out.notContinuing, "person", "people")} on the ${out.code} roster ${out.notContinuing === 1 ? "has" : "have"} no place on the ${incoming.code} roster. Promote accepted returners, then offboard the rest before activating: once ${incoming.code} is live they appear on no offboarding list, and they keep their sign-in.`,
        link: { href: "/volunteers/offboarding?tab=transition", label: "Open the transition list" },
      });
    } else {
      items.push({
        key: "offboard",
        tone: "success",
        text: `Everyone on the ${out.code} roster is continuing into ${incoming.code} or already offboarded.`,
      });
    }

    if (out.termScopedRoles.length > 0) {
      const roles = out.termScopedRoles.map((r) => `${r.roleName} (${r.count})`).join(", ");
      items.push({
        key: "roles",
        tone: "warning",
        text: `These role assignments are scoped to ${out.code} and stop granting the moment ${incoming.code} is active: ${roles}. Rescope them to Global or ${incoming.code} first.`,
        link: { href: "/admin/roles", label: "Open roles" },
      });
    }
  }

  for (const c of readiness.incoming.unpromoted) {
    items.push({
      key: `unpromoted:${c.cycleId}`,
      tone: "warning",
      text: `${count(c.count, "accepted applicant")} in ${c.title} ${c.count === 1 ? "is" : "are"} not on the ${incoming.code} roster yet.`,
      link: { href: `/recruitment/cycles/${c.cycleId}/onboarding`, label: "Open onboarding" },
    });
  }

  const inc = readiness.incoming;
  if (inc.members === 0) {
    items.push({ key: "gate", tone: "info", text: `Nobody is on the ${incoming.code} roster yet.` });
  } else if (inc.heldAtGate > 0) {
    const steps = inc.heldBySteps.map((s) => `${stepLabels[s.key] ?? s.key} (${s.count})`).join(", ");
    items.push({
      key: "gate",
      tone: "warning",
      text: `${inc.heldAtGate} of ${inc.members} ${incoming.code} members would be held at onboarding as soon as it is active. Missing: ${steps}.`,
      link: { href: `/volunteers/master?term=${incoming.id}`, label: "Review in the master view" },
    });
  } else {
    items.push({
      key: "gate",
      tone: "success",
      text: `All ${inc.members} ${incoming.code} members would clear onboarding.`,
    });
  }

  if (inc.unpublishedDepartments.length > 0) {
    items.push({
      key: "drafts",
      tone: "info",
      text: `${incoming.code} schedules are not published for ${inc.unpublishedDepartments.join(", ")}. Once ${incoming.code} is live, members see every drafted shift and get reminders for it.`,
      link: { href: `/schedule/builder?term=${incoming.id}`, label: "Open the builder" },
    });
  }

  return items;
}
