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
 * What a draft shift on an incoming member means, for the chip's tooltip.
 *
 * True of everyone incoming, returner or first-timer: nothing reaches them and
 * nothing shows clinic-wide until roster build, and then the drafts simply count.
 */
export const PROVISIONAL_BADGE_TITLE =
  "Accepted; not on the roster yet. Shifts drafted now carry over when they are added to it.";
