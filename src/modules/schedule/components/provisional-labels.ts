/**
 * Shared wording for the builder's incoming rows.
 *
 * The grid, the Day view, and the availability view all render the same people,
 * and a director moving between them should not have to work out that "Accepted"
 * on one surface and "Incoming" on another mean the same person. One module, so
 * the three cannot drift.
 */

import type { BuilderProvisional } from "@/modules/schedule/services/builder";

/** The short chip every surface shows on an incoming row. */
export const PROVISIONAL_BADGE_LABEL = "Incoming";

/**
 * Where the person is in the pipeline, spelled out. Shown where there is room for
 * a second chip (the Day view card, the availability card); the grid has ~52px
 * columns and shows the short badge alone.
 */
export const PROVISIONAL_STAGE_LABEL: Record<BuilderProvisional["stage"], string> = {
  ACCEPTED: "Accepted",
  ONBOARDING: "Onboarding",
  SUBMITTED: "Awaiting roster build",
};

/**
 * Why an incoming row cannot be assigned, or null when it can be.
 *
 * A first-time applicant has no Hub account until roster build creates one, and a
 * shift is keyed on a person, so there is nothing to assign a shift to. Said out
 * loud on the row rather than left as a cell that silently does nothing.
 */
export function provisionalBlockedReason(p: BuilderProvisional): string | null {
  return p.placeable ? null : "No Hub account until they are added to the roster";
}
