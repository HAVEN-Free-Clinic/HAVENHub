/**
 * Where each viewer admitted to Volunteers by something other than
 * `volunteers.view` should land.
 *
 * /volunteers IS the module root, so it is where the dashboard tile, the
 * toolbar chip and the "Volunteers" breadcrumb all point. It requires
 * `volunteers.view` -- but that is only one of the five ways into this module,
 * and the other four are admitted by `additionalAccessPermissions`. Each of
 * them was shown the tile and bounced to /no-access on clicking it.
 *
 * Kept out of page.tsx so `module-entry.test.ts` can assert the real invariant:
 * every permission the registry admits the module on has a landing page here.
 * That is the check that was missing when `verify_spanish` got a redirect and
 * the three added after it did not.
 *
 * Ordered as the nav row is, so a viewer lands on the first tab they would see
 * rather than on whichever branch happened to be checked first. Two permissions
 * share a destination because the directory page admits on either.
 */
export const VOLUNTEER_ENTRY_FALLBACKS: readonly (readonly [permission: string, href: string])[] = [
  ["volunteers.view_directory", "/volunteers/directory"],
  ["volunteers.view_directory_own_dept", "/volunteers/directory"],
  ["volunteers.view_compliance", "/volunteers/ehs"],
  ["volunteers.verify_spanish", "/volunteers/spanish-review"],
] as const;
