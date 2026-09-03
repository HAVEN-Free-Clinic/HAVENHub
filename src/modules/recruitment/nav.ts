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
 * The Events tab's href, named here so the registry entry and the layout's
 * dynamic gate cannot drift apart. Its gate is "may record attendance on any
 * scope" (see canRecordAttendance), which mixes a permission with a director's
 * review scope and so cannot be expressed in the registry.
 */
export const EVENTS_HREF = "/recruitment/events";

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

/**
 * The recruitment module id + nav extras the *global* nav needs, both derived
 * from the same two booleans so they cannot drift out of sync.
 *
 * `filterAccessibleModules` decides whether the recruitment module row appears
 * at all (via `extraModuleIds`) *before* it looks at `extraNavItems` -- so a
 * bare panelist (on an interview panel but holding neither recruitment.access
 * nor a review scope, e.g. added via listPanelistCandidates) needs
 * "recruitment" in extraModuleIds or the "My interviews" item in extraNavItems
 * is silently discarded because the module row never gets created. Computing
 * both from isReviewer/isPanelist together in one place is what prevents that:
 * a caller that only threads isPanelist into extraNavItems (as an earlier
 * version of this file did) reintroduces the bug.
 */
export function recruitmentGlobalNav(opts: { isReviewer: boolean; isPanelist: boolean }): {
  extraModuleIds: string[];
  extraNavItems: Record<string, ModuleNavItem[]>;
} {
  return {
    extraModuleIds: opts.isReviewer || opts.isPanelist ? ["recruitment"] : [],
    extraNavItems: opts.isPanelist ? { recruitment: [MY_INTERVIEWS_NAV_ITEM] } : {},
  };
}
