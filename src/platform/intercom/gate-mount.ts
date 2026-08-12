/**
 * Whether the content blocker gate should mount for this person on this request.
 *
 * The gate blocks the whole app with a modal that cannot be dismissed, so it has
 * three independent off-switches and getting the combination wrong fails badly in
 * both directions: too permissive fires a hard block in CI or for someone who
 * cannot comply, too strict silently disables the feature. Three booleans ANDed
 * inline in JSX is exactly where that mistake hides, so the rule lives here, with
 * tests, rather than in the layout's markup.
 *
 * Deliberately NOT the condition for the Messenger itself, which mounts on the
 * app id alone. Every switch here only ever subtracts the gate: standing the gate
 * down must never take support away from the people who can still reach it.
 */
export function shouldMountBlockerGate(input: {
  /** Null (or empty) whenever Intercom is unconfigured: dev, CI, e2e, preview, demo. */
  supportAppId: string | null;
  /** The support.blockerGateEnabled setting, the runtime kill switch for an outage. */
  gateEnabled: boolean;
  /** Person.blockerGateExempt, for someone on a device or network they cannot change. */
  personExempt: boolean;
}): boolean {
  if (!input.supportAppId) return false;
  if (!input.gateEnabled) return false;
  if (input.personExempt) return false;
  return true;
}
