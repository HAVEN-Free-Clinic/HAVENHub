import type { ModuleNavItem } from "@/platform/modules/types";

/**
 * The panelist-facing "My interviews" tab. It lives here rather than in the
 * module registry nav because its visibility is gated on a *dynamic* condition
 * (whether the viewer is on any interview panel), not on a permission, so the
 * registry's permission-based filterNavItems cannot express it.
 */
export const MY_INTERVIEWS_NAV_ITEM: ModuleNavItem = {
  label: "My interviews",
  href: "/recruitment/interviews",
};

/**
 * Assemble the recruitment module's nav tabs for a viewer. `staffNav` is the
 * already permission-filtered staff nav (empty for non-staff). Anyone on an
 * interview panel additionally gets the "My interviews" tab, appended after the
 * staff tabs so the staff ordering is preserved.
 */
export function recruitmentNavItems(opts: {
  staffNav: ModuleNavItem[];
  isPanelist: boolean;
}): ModuleNavItem[] {
  return opts.isPanelist ? [...opts.staffNav, MY_INTERVIEWS_NAV_ITEM] : [...opts.staffNav];
}
