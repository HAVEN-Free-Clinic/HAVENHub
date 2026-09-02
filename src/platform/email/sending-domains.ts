/**
 * Verified sending domains: which transport can DKIM-sign for which From domain.
 *
 * A plain yes/no allowlist would not be enough, because the two domains we send
 * from are signable by DIFFERENT transports, and mail signed by the wrong one
 * fails DMARC rather than merely looking odd. Verified in DNS on 2026-09-02,
 * consistent with a live Maileroo send probed on 2026-08-21:
 *
 *   havenfreeclinic.org -- SPF includes _spf.maileroo.com, DMARC p=reject,
 *     verified in the Maileroo account and sending today. GRAPH cannot sign it:
 *     Exchange Online's sending IPs are not authorized by that SPF record.
 *   yale.edu -- SPF is Valimail only with NO _spf.maileroo.com include, no
 *     Maileroo DKIM selector at maileroo._domainkey, DMARC p=quarantine. The
 *     domain IS registered in the Maileroo account but is DISABLED there: a live
 *     send returns HTTP 400 "The domain 'yale.edu' is currently disabled."
 *     MAILEROO cannot sign it; Graph does, as the delegated hfc.it@yale.edu
 *     mailbox.
 *
 * So each domain maps to the transport that can actually sign for it, and a
 * domain that is on neither list falls back to the sending transport's own
 * pinned address (see MailerooTransport).
 *
 * WHEN MAILEROO'S yale.edu ENTRY IS RE-ENABLED this is a ONE-LINE change: flip
 * the "yale.edu" row below from "graph" to "maileroo". Nothing else moves --
 * MailerooTransport, SigningDomainRouter, the admin sender test and the queue
 * all read this map and none of them names a domain. Re-enabling is a Yale ITS
 * DNS change plus a Maileroo dashboard action rather than a code change, so the
 * same flip is available WITHOUT A CODE EDIT through the SENDING_DOMAINS env
 * override (declared and format-checked in platform/config.ts).
 *
 * "Without a code edit" is the accurate claim, and it is narrower than it may
 * read. It is NOT "without a deploy": a Vercel environment change only reaches
 * running functions on a redeploy, and the map below is resolved once at module
 * load, so a fresh process is needed either way. What the override buys is that
 * the change is an operator action rather than a pull request.
 */
import { config } from "@/platform/config";
import { domainOf } from "./address";

/** The transports that can hold a domain's DKIM signature. */
export type SigningTransport = "maileroo" | "graph";

/**
 * The allowlist as shipped. The env override REPLACES this wholesale rather than
 * merging into it, so an operator narrowing the list gets the narrowing they
 * asked for instead of a union with a stale built-in.
 */
export const DEFAULT_SENDING_DOMAINS: Readonly<Record<string, SigningTransport>> = {
  "havenfreeclinic.org": "maileroo",
  // Graph, not Maileroo: see the yale.edu paragraph above. This is the one line.
  "yale.edu": "graph",
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

/**
 * The domain part of an address. Re-exported from ./address, where it lives so a
 * CLIENT component can import it: this module resolves the allowlist from
 * `@/platform/config` at import time and must not reach the browser. Every
 * existing importer keeps the name it already used.
 */
export { domainOf } from "./address";

/**
 * The transport that can DKIM-sign for this From address, or null when its
 * domain is not on the allowlist and the caller must fall back to its pinned
 * sender.
 *
 * Matches the domain EXACTLY, so mail.yale.edu does not inherit yale.edu's
 * verdict: a subdomain publishes its own SPF and DKIM records, and treating the
 * parent's as authoritative for it would be a guess dressed up as a check.
 */
export function signingTransportFor(
  address: string | null | undefined
): SigningTransport | null {
  const domain = domainOf(address);
  if (!domain) return null;
  return SENDING_DOMAINS.get(domain) ?? null;
}
