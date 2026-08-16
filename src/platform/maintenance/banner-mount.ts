/**
 * Whether the maintenance banner mounts, as one named rule rather than three
 * conditions ANDed inline in the root layout. Same shape and same reason as
 * shouldMountBlockerGate: the switches get names and tests.
 *
 * The banner exists to remind the one person who can still use the hub that
 * nobody else can, so its audience is exactly the people the proxy lets past.
 * Mounting it on the switch alone put it on every surface that stays up during
 * a window -- /login for any member or applicant, and /credential/[token] for
 * anyone outside the clinic opening a volunteer's public passport link -- which
 * showed an internal operations notice to people it was not for.
 */
export function shouldShowMaintenanceBanner({
  enabled,
  isMaintenancePath,
  holdsBypass,
}: {
  /** The maintenance.enabled setting. */
  enabled: boolean;
  /** True on /maintenance itself, where the page already says all of this at full size. */
  isMaintenancePath: boolean;
  /** True when this visitor holds the bypass grant, i.e. is browsing the hub during a window. */
  holdsBypass: boolean;
}): boolean {
  return enabled && holdsBypass && !isMaintenancePath;
}
