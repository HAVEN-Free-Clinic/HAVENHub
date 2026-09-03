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

/** The transports that can hold a From's DKIM signature. */
export type SigningTransport = "maileroo" | "graph";

/**
 * Which rule decided a From's transport. Carried out of the decision because the
 * two rules have DIFFERENT remedies, and a diagnosis that names the wrong lever
 * sends an operator to edit a variable that has nothing to do with their
 * failure -- the same mistake Graph's own "check credentials" makes on a
 * Send-As refusal.
 *
 *   "address" -- GRAPH_SENDER_ADDRESSES names this exact mailbox.
 *   "mailbox" -- it IS the mailbox Graph is connected as. No list entry needed.
 *   "domain"  -- SENDING_DOMAINS carries its domain.
 */
export type SigningRule = "address" | "mailbox" | "domain";

export type SigningDecision = { transport: SigningTransport; rule: SigningRule };

/** The inputs a routing decision needs, as plain collections. */
export type SigningRules = {
  /** Mailboxes pinned to Graph regardless of their domain. Lowercased. */
  graphAddresses: ReadonlySet<string>;
  /** Domain -> the transport that can DKIM-sign for it. Keys lowercased. */
  domains: ReadonlyMap<string, SigningTransport>;
  /**
   * The mailbox Graph is connected as, or null. Graph-routed with no list entry:
   * `/users/{from}/sendMail` can always act on its own mailbox, and that is true
   * of any deployment rather than of one org's address.
   */
  graphMailbox?: string | null;
};

/**
 * The transport that can sign for this From, and WHICH rule said so, or null
 * when nothing claims it.
 *
 * ADDRESS BEFORE DOMAIN, which is the whole point of this function existing.
 * A domain-keyed answer cannot express the rule the clinic actually needs:
 * `hfc.admin@yale.edu` and `alice@yale.edu` share a domain and need different
 * transports. They need different transports for a reason that is a fact about
 * Microsoft rather than a preference -- Graph sends via `/users/{from}/sendMail`,
 * so the From must be a mailbox inside the tenant. A personal Yale mailbox is
 * hosted on-premise and answers 404 MailboxNotEnabledForRESTAPI; a shared clinic
 * mailbox is in Exchange Online and does not. So the address list names the
 * mailboxes Graph can genuinely act on, and everything else falls through to the
 * domain table exactly as before.
 *
 * Shared with the CLIENT rather than reimplemented there: this module has no
 * imports on purpose (sending-domains.ts resolves from `@/platform/config` and
 * must not reach the browser), so the panel that warns an admin at configure
 * time and the router that decides at send time cannot disagree about which
 * transport an address is on. That is the same argument EMAIL_RE living here
 * already makes.
 *
 * Domains match EXACTLY -- mail.yale.edu does not inherit yale.edu's verdict,
 * because a subdomain publishes its own SPF and DKIM records.
 */
export function decideSigningTransport(
  address: string | null | undefined,
  rules: SigningRules
): SigningDecision | null {
  const normalized = address?.trim().toLowerCase();
  if (!normalized) return null;
  if (rules.graphAddresses.has(normalized)) return { transport: "graph", rule: "address" };
  const mailbox = rules.graphMailbox?.trim().toLowerCase();
  if (mailbox && mailbox === normalized) return { transport: "graph", rule: "mailbox" };
  const domain = domainOf(normalized);
  if (!domain) return null;
  const transport = rules.domains.get(domain);
  return transport ? { transport, rule: "domain" } : null;
}
