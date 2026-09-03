/**
 * How a From address is routed to a transport. TWO rules, address before domain.
 *
 * The file is still named for the domain table because that is the larger and
 * older half of it, and renaming it would churn a dozen importers for no gain.
 * What it holds now is:
 *
 *   GRAPH_SENDER_ADDRESSES -- specific mailboxes pinned to Graph, whatever their
 *     domain says. Checked FIRST. See its own comment for why domain is not a
 *     fine enough key.
 *   SENDING_DOMAINS -- the verified-domain allowlist below, unchanged. Everything
 *     the address rule does not claim falls through to it exactly as before.
 *
 * Verified sending domains: which transport can DKIM-sign for which From domain.
 *
 * A plain yes/no allowlist would not be enough, because a From domain is only
 * signable by the transports that hold a key for it, and mail signed by the
 * wrong one fails DMARC rather than merely looking odd.
 *
 *   havenfreeclinic.org -- SPF includes _spf.maileroo.com, DMARC p=reject,
 *     verified in the Maileroo account and sending today. GRAPH cannot sign it:
 *     Exchange Online's sending IPs are not authorized by that SPF record.
 *   yale.edu -- verified in the Maileroo account as of 2026-09-02, so Maileroo
 *     holds a published DKIM key for it and signs it as itself.
 *
 * On yale.edu's SPF, because it looks alarming and is not: the record is
 * Valimail only and carries NO _spf.maileroo.com include. That does not block
 * anything. DMARC passes when EITHER SPF or DKIM aligns, so a Maileroo DKIM
 * signature on d=yale.edu satisfies its p=quarantine policy on its own. Do not
 * "fix" this by chasing an SPF include, and do not read the absence of a
 * maileroo._domainkey record as evidence either way: havenfreeclinic.org has no
 * record at that selector name either, and it has been sending through Maileroo
 * for months. Maileroo's own dashboard verification is the authority on whether
 * it will sign a domain; DNS probing from outside is not.
 *
 * So each domain maps to the transport that can actually sign for it, and a
 * domain that is on neither list falls back to the sending transport's own
 * pinned address (see MailerooTransport).
 *
 * yale.edu WAS routed to Graph here, while its Maileroo entry was disabled. On
 * 2026-09-02 Maileroo marked it valid and the row flipped to "maileroo" -- a
 * one-line change, exactly as designed: MailerooTransport, SigningDomainRouter,
 * the admin sender test and the queue all read this map and none of them names
 * a domain. Two consequences follow automatically and are worth knowing, since
 * both were live constraints until that flip: a yale.edu identity no longer
 * needs an Exchange Send-As grant, and it no longer paces against Exchange
 * Online's ~30 messages/minute submission ceiling. SenderIdentityNotes drops
 * both warnings on its own, because it branches on this map rather than on a
 * domain name.
 *
 * If Maileroo ever disables it again, the reverse flip is available WITHOUT A
 * CODE EDIT through the SENDING_DOMAINS env override (declared and
 * format-checked in platform/config.ts) -- set "yale.edu:graph" to put it back
 * on the delegated hfc.it@yale.edu mailbox.
 *
 * "Without a code edit" is the accurate claim, and it is narrower than it may
 * read. It is NOT "without a deploy": a Vercel environment change only reaches
 * running functions on a redeploy, and the map below is resolved once at module
 * load, so a fresh process is needed either way. What the override buys is that
 * the change is an operator action rather than a pull request.
 */
import { config } from "@/platform/config";
import {
  decideSigningTransport,
  EMAIL_RE,
  type SigningDecision,
  type SigningTransport,
} from "./address";

/**
 * The transports that can hold a domain's DKIM signature. Defined in ./address
 * (which the browser may import) and re-exported here so every existing importer
 * keeps the name it already used.
 */
export type { SigningDecision, SigningTransport } from "./address";

/**
 * The allowlist as shipped. The env override REPLACES this wholesale rather than
 * merging into it, so an operator narrowing the list gets the narrowing they
 * asked for instead of a union with a stale built-in.
 */
export const DEFAULT_SENDING_DOMAINS: Readonly<Record<string, SigningTransport>> = {
  "havenfreeclinic.org": "maileroo",
  // Maileroo since 2026-09-02, when it verified the domain. See above; this is
  // the one line, and "yale.edu:graph" in SENDING_DOMAINS reverses it.
  "yale.edu": "maileroo",
};

/**
 * One "<domain>:<transport>" pair. Kept in sync with the format check in
 * config.ts, which refuses to boot on a malformed override -- this regex is the
 * second half of that pair and exists so one bad entry cannot empty the map.
 */
const ENTRY_RE = /^([^\s@:,]+):(maileroo|graph)$/;

/**
 * Parse a SENDING_DOMAINS override, or fall back to the default table.
 *
 * An empty or whitespace-only spec means "not configured", NOT "no domains are
 * verified". That distinction is load-bearing twice over: an unset Vercel
 * variable arrives as "", and vitest.setup.ts deliberately claims every
 * external-service env name as "" so a local run cannot diverge from CI. Reading
 * either as an empty allowlist would silently pin every send.
 *
 * A spec that is non-empty but names NO usable pair -- "," or "yale.edu:smtp" --
 * gets the same treatment, and for the same reason: an empty allowlist is the one
 * outcome with no safe reading, because it puts every message on the pinned
 * fallback in silence. config.ts REFUSES to boot on that input, so this branch is
 * unreachable in a booted app; it exists so the direction is safe rather than
 * silent if that check is ever relaxed. The two halves agree the input is
 * degenerate and differ only in how loudly they say so.
 */
export function parseSendingDomains(spec: string | undefined): Map<string, SigningTransport> {
  const map = new Map<string, SigningTransport>();
  const source = spec?.trim();
  if (!source) return withDefaults(map);
  for (const entry of source.split(",")) {
    const match = ENTRY_RE.exec(entry.trim());
    // Skips both a malformed pair and an EMPTY segment, the latter being a
    // trailing comma or a stray double comma. config.ts's boot check has to skip
    // an empty segment explicitly, because it has no regex to fall through to.
    // The two halves must agree here or the strict one refuses to boot on input
    // this one reads correctly, which is what a trailing comma on the emergency
    // SENDING_DOMAINS lever used to do to the whole app. When EVERY segment is
    // skipped the result is an empty allowlist, which is handled at the return.
    if (!match) continue;
    // A domain listed twice takes its LAST verdict, the ordinary convention for a
    // key/value list. Documented rather than rejected: it is the one ambiguous
    // input neither this parser nor config.ts's boot check flags, so a reader
    // should not have to infer which end wins.
    map.set(match[1].toLowerCase(), match[2] as SigningTransport);
  }
  return map.size > 0 ? map : withDefaults(map);
}

/** Fill an empty map with the shipped table. */
function withDefaults(map: Map<string, SigningTransport>): Map<string, SigningTransport> {
  for (const [domain, transport] of Object.entries(DEFAULT_SENDING_DOMAINS)) {
    map.set(domain, transport);
  }
  return map;
}

/** The resolved allowlist for this process. */
export const SENDING_DOMAINS: ReadonlyMap<string, SigningTransport> = parseSendingDomains(
  config.SENDING_DOMAINS
);

// ---------------------------------------------------------------------------
// The address-level rule, which runs BEFORE the domain table
// ---------------------------------------------------------------------------

/**
 * The mailboxes pinned to Graph by name, regardless of their domain.
 *
 * WHY AN ADDRESS RULE HAD TO EXIST. The table above answers "which transport can
 * DKIM-sign for this domain", and that is a true and useful question -- but it is
 * not the only constraint on a From. Graph sends via `/users/{from}/sendMail`, so
 * the From must ALSO be a mailbox inside the Microsoft tenant. Those two
 * questions have different answers for two addresses on one domain:
 * hfc.admin@yale.edu is a shared mailbox in Exchange Online and Graph sends as it
 * every day; a personal yale.edu mailbox is hosted on-premise and Graph answers
 * `404 MailboxNotEnabledForRESTAPI -- "The mailbox is either inactive,
 * soft-deleted, or is hosted on-premise."` No row of SENDING_DOMAINS can express
 * that, because both are yale.edu.
 *
 * So this list names the mailboxes Graph can genuinely act on, address wins over
 * domain, and everything unlisted falls through to the domain table exactly as
 * before. The rule is not a preference about which transport is nicer: for the
 * addresses on this list Maileroo and Graph both work and Graph is chosen; for
 * everything else Graph cannot work at all.
 *
 * SHIPPED EMPTY, and that is a product decision rather than an oversight. Which
 * mailboxes an organisation owns is org-specific, and this application keeps its
 * org name, branding, departments and support address in settings for exactly
 * that reason -- a shared mailbox belongs no more in a shipped constant than the
 * clinic's name does. The deploying org sets GRAPH_SENDER_ADDRESSES; .env.example
 * documents the clinic's own three as the worked example.
 *
 * An empty set is SAFE but not automatically CORRECT: it routes every address by
 * domain, which is precisely the behaviour that existed before this list, and on
 * a Maileroo deployment that means every configured sender moves to Maileroo. It
 * is safe because nothing breaks and unsafe to leave unexamined because nobody
 * decided it. That gap is what routing-gap.ts surfaces to an admin.
 */
export const DEFAULT_GRAPH_SENDER_ADDRESSES: readonly string[] = [];

/**
 * Parse a GRAPH_SENDER_ADDRESSES list, or fall back to the shipped default.
 *
 * The three lessons from parseSendingDomains apply unchanged, because the two
 * failure modes are the same shape:
 *
 *   - Empty or whitespace-only means "NOT CONFIGURED", not "configured to
 *     nothing". An unset Vercel variable arrives as "", and vitest.setup.ts
 *     claims every external-service env name as "" so a local run cannot diverge
 *     from CI. Here the two happen to produce the same set, since the default IS
 *     empty; the distinction is kept anyway so it stays true if a deployment ever
 *     ships a default, and so config.ts can refuse the degenerate input below
 *     while accepting the unset one.
 *   - A non-empty spec naming NO usable address gets config.ts's refusal, for the
 *     reason recorded there. This branch is unreachable in a booted app and
 *     exists so the direction is safe rather than silent if that check is
 *     relaxed.
 *   - REPLACE, not merge -- the same choice the domain table makes, and for the
 *     same reason: an operator who lists two mailboxes must get two, not two plus
 *     whatever a future release adds to the default. It costs nothing today
 *     (the default is empty, so replace and merge agree) and the decision is
 *     recorded now rather than inferred later from behaviour nobody chose.
 */
export function parseGraphSenderAddresses(spec: string | undefined): Set<string> {
  const set = new Set<string>();
  const source = spec?.trim();
  if (!source) return withDefaultAddresses(set);
  for (const entry of source.split(",")) {
    const address = entry.trim().toLowerCase();
    // Skips both a malformed address and an EMPTY segment (a trailing comma).
    // config.ts's boot check has to distinguish those two explicitly because it
    // reports rather than skips; the two halves must agree on which inputs are
    // acceptable or the strict one refuses input this one reads correctly.
    //
    // The colon check is the second half of the pair documented in config.ts:
    // EMAIL_RE accepts "hfc.admin@yale.edu:graph" (it reads ":graph" as part of
    // the domain), which is the shape of the SENDING_DOMAINS value sitting right
    // next to this one in .env.example. config.ts refuses to boot on it, so this
    // branch is unreachable in a booted app; it is here so the two halves do not
    // disagree about what a usable entry is.
    if (!EMAIL_RE.test(address) || address.includes(":")) continue;
    set.add(address);
  }
  return set.size > 0 ? set : withDefaultAddresses(set);
}

/** Fill an empty set with the shipped list. */
function withDefaultAddresses(set: Set<string>): Set<string> {
  for (const address of DEFAULT_GRAPH_SENDER_ADDRESSES) set.add(address.toLowerCase());
  return set;
}

/** The resolved Graph address list for this process. */
export const GRAPH_SENDER_ADDRESSES: ReadonlySet<string> = parseGraphSenderAddresses(
  config.GRAPH_SENDER_ADDRESSES
);

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * The domain part of an address. Re-exported from ./address, where it lives so a
 * CLIENT component can import it: this module resolves the allowlist from
 * `@/platform/config` at import time and must not reach the browser. Every
 * existing importer keeps the name it already used.
 */
export { domainOf } from "./address";

/**
 * The transport that can sign for this From and WHICH rule said so, or null when
 * nothing claims it and the caller must fall back to its pinned sender.
 *
 * Address first, then the connected mailbox, then the domain table -- the
 * precedence itself lives in ./address so the client-side configure-time warning
 * runs the identical decision. This wrapper's only job is to hand it this
 * process's resolved lists.
 *
 * `graphMailbox` is optional because most callers are answering a question the
 * connected mailbox does not change (an admin typing an address into a form, a
 * write-time signability check). The SEND path passes it, because there the
 * question is "which transport will actually carry this message" and Graph can
 * always send as its own mailbox.
 */
export function signingDecisionFor(
  address: string | null | undefined,
  graphMailbox?: string | null
): SigningDecision | null {
  return decideSigningTransport(address, {
    graphAddresses: GRAPH_SENDER_ADDRESSES,
    domains: SENDING_DOMAINS,
    graphMailbox,
  });
}

/**
 * The transport that can sign for this From address, or null when no rule claims
 * it and the caller must fall back to its pinned sender.
 *
 * Matches the domain EXACTLY, so mail.yale.edu does not inherit yale.edu's
 * verdict: a subdomain publishes its own SPF and DKIM records, and treating the
 * parent's as authoritative for it would be a guess dressed up as a check.
 */
export function signingTransportFor(
  address: string | null | undefined,
  graphMailbox?: string | null
): SigningTransport | null {
  return signingDecisionFor(address, graphMailbox)?.transport ?? null;
}
