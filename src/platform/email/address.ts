/**
 * Address parsing with NO dependencies, so a client component can use it.
 *
 * Split out of sending-domains.ts for exactly that reason: that module resolves
 * the allowlist at import time from `@/platform/config`, which reads the
 * environment and must never be bundled into the browser. The UI that warns
 * about a sending domain needs the domain of whatever the admin is typing, so
 * it gets this function and is handed the resolved allowlist as plain data.
 */

/**
 * The domain part of an email address, lowercased, or null when the value is not
 * an address with a domain. Deliberately permissive about the local part: this
 * answers "which domain would this be signed under", not "is this deliverable".
 */
export function domainOf(address: string | null | undefined): string | null {
  const trimmed = address?.trim();
  if (!trimmed) return null;
  const at = trimmed.lastIndexOf("@");
  // at < 1 covers both "no @" and "@nolocalpart"; the last check covers "x@".
  if (at < 1 || at === trimmed.length - 1) return null;
  return trimmed.slice(at + 1).toLowerCase();
}

/**
 * A pragmatic email check: non-space, an @, a dot in the domain.
 *
 * Lives here so the two sender-identity write seams and the pre-existing
 * `saveSenderRule` share ONE pattern rather than each carrying its own. It is
 * deliberately not an RFC 5322 parser: semantic validity (Send-As rights, a
 * signable domain) is decided elsewhere. What it does catch is the class that
 * `domainOf` cannot -- a local part with a space or a second `@` passes the
 * domain check, stores fine, and then fails at send, which is exactly what a
 * write-time check exists to prevent.
 */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
