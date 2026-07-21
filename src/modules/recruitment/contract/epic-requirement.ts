import type { EpicRequirement, Track } from "@prisma/client";

type EpicColumns = {
  requiresEpicDirector: EpicRequirement;
  requiresEpicVolunteer: EpicRequirement;
};

/** Pick the requirement column matching the cycle's track. A null department
 *  (an acceptance whose departmentCode no longer resolves) yields NONE: with no
 *  department there is no basis to provision Epic, and defaulting the other way
 *  would raise EpicRequests nobody asked for. */
export function epicRequirementFor(dept: EpicColumns | null, track: Track): EpicRequirement {
  if (!dept) return "NONE";
  return track === "DIRECTOR" ? dept.requiresEpicDirector : dept.requiresEpicVolunteer;
}

/** Collapse the requirement plus the applicant's answer into the boolean that
 *  promotion.ts reads to decide whether to create an EpicRequest. Only SOME
 *  consults the applicant; ALL and NONE are decided by the department. */
export function resolveEpicNeeded(requirement: EpicRequirement, selfReported: boolean): boolean {
  if (requirement === "ALL") return true;
  if (requirement === "NONE") return false;
  return selfReported;
}
