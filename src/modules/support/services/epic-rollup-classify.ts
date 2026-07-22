import type { EpicRequirement, Track } from "@prisma/client";
import {
  epicRequirementFor,
  resolveEpicNeeded,
} from "@/modules/recruitment/contract/epic-requirement";

/** The three access-granting groups the term roll-up splits people into. */
export type RollupGroupKind = "NEW" | "MODIFY" | "RENEW";

/** One ACTIVE membership in the target term, flattened with its department's
 *  Epic requirement columns so classification needs no further lookups. */
export type RollupMembership = {
  departmentId: string;
  kind: Track;
  requiresEpicDirector: EpicRequirement;
  requiresEpicVolunteer: EpicRequirement;
};

export type RollupNeed = {
  /** Whether this person belongs on the roll-up at all. */
  needed: boolean;
  /** True when the only signal is a SOME department with nothing to decide it:
   *  the person is shown but starts unchecked so ITCM opts them in explicitly. */
  optional: boolean;
};

/**
 * Whether a roster member needs an Epic request this term.
 *
 * ALL from any department decides it outright. SOME is decided by the person's
 * onboarding contract for this term, or by their already having an Epic ID (they
 * were provisioned before, so the answer was yes). A SOME department with neither
 * signal yields needed with optional set, rather than dropping the person: a
 * roster carry-forward has no contract, and silently omitting them would hide
 * someone who does need access.
 */
export function resolveRollupNeed(
  memberships: RollupMembership[],
  opts: { contractEpicNeeded: boolean; hasEpicId: boolean }
): RollupNeed {
  const requirements = memberships.map((m) =>
    epicRequirementFor(
      {
        requiresEpicDirector: m.requiresEpicDirector,
        requiresEpicVolunteer: m.requiresEpicVolunteer,
      },
      m.kind
    )
  );
  if (requirements.some((r) => r === "ALL")) return { needed: true, optional: false };
  if (!requirements.some((r) => r === "SOME")) return { needed: false, optional: false };

  const selfReported = opts.contractEpicNeeded || opts.hasEpicId;
  return { needed: true, optional: !resolveEpicNeeded("SOME", selfReported) };
}

/**
 * Which kind of request a roster member needs.
 *
 * No Epic ID means a brand new account. An existing Epic ID with no prior HAVEN
 * term means an account that exists at YNHH but has never carried the
 * YM HAVEN FREE CLINIC department, which is a MODIFY. Otherwise the department
 * set decides: any change (added, dropped, or swapped) is a MODIFY, an identical
 * set is a straight RENEW for the new term.
 *
 * priorDepartmentIds is null when the person held no ACTIVE membership in any
 * earlier term. That covers first-time members and, deliberately, people who were
 * offboarded (offboarding flips ALL their memberships to REMOVED, so their history
 * reads as absent). A returning offboarded member had their Epic access
 * deactivated on the way out, so MODIFY, which YNHH reads as reactivate-and-extend,
 * is the correct request for them.
 *
 * Comparison is on department ids only, not on Track: a volunteer promoted to
 * director in the same department is a RENEW.
 */
export function classifyEpicKind(input: {
  hasEpicId: boolean;
  termDepartmentIds: string[];
  priorDepartmentIds: string[] | null;
}): RollupGroupKind {
  if (!input.hasEpicId) return "NEW";
  if (input.priorDepartmentIds === null) return "MODIFY";

  const prior = new Set(input.priorDepartmentIds);
  const current = new Set(input.termDepartmentIds);
  if (current.size !== prior.size) return "MODIFY";
  for (const id of current) {
    if (!prior.has(id)) return "MODIFY";
  }
  return "RENEW";
}
