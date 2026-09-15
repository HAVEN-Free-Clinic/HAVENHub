/**
 * Who /volunteers admits, and where everyone else admitted to Volunteers lands.
 *
 * /volunteers IS the module root, so it is where the dashboard tile, the
 * toolbar chip and the "Volunteers" breadcrumb all point. It is also the one
 * compliance roster, which admits `volunteers.view` (a director, scoped to the
 * departments they direct) and the two clinic-wide compliance permissions. The
 * registry admits the module on more than those, and each of the others was
 * once shown the tile and bounced to /no-access on clicking it.
 *
 * Kept out of page.tsx so `module-entry.test.ts` can assert the real invariant:
 * every permission the registry admits the module on either opens the roster
 * or has a landing page here. That is the check that was missing when
 * `verify_spanish` got a redirect and the three added after it did not.
 *
 * Ordered as the nav row is, so a viewer lands on the first tab they would see
 * rather than on whichever branch happened to be checked first. Two permissions
 * share a destination because the directory page admits on either.
 */

/** Permissions that open the roster for the whole clinic rather than a scope. */
export const CLINIC_WIDE_ROSTER_PERMISSIONS = [
  "volunteers.view_compliance",
  "volunteers.manage_compliance",
] as const;

export const VOLUNTEER_ENTRY_FALLBACKS: readonly (readonly [permission: string, href: string])[] = [
  ["volunteers.view_directory", "/volunteers/directory"],
  ["volunteers.view_directory_own_dept", "/volunteers/directory"],
  ["volunteers.verify_spanish", "/volunteers/spanish-review"],
] as const;
