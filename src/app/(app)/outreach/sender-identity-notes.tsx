"use client";

/**
 * The two things about a sending identity that are invisible unless the UI says
 * them out loud, shown wherever an identity is CHOSEN or CONFIGURED rather than
 * buried in a doc. Both were discovered the expensive way.
 *
 * 1. THE GRAPH THROUGHPUT CEILING. A yale.edu identity routes to Microsoft
 *    Graph, which inherits Exchange Online's roughly 30 messages per minute
 *    submission cap. That ceiling is the reason MailerooTransport exists at all.
 *    A roster-wide campaign from a yale.edu identity paces out over hours; the
 *    same campaign from havenfreeclinic.org does not. Nothing in the send path
 *    surfaces this: the campaign just appears to be taking a long time.
 *
 * 2. THE SEND-AS REQUIREMENT. ALL @yale.edu is deliberately routed through
 *    Graph, which sends as the one connected mailbox's delegated session. An
 *    address that mailbox has no Exchange Send-As grant on fails PERMANENTLY.
 *    Task 1 made that failure legible at send time; this makes it visible at
 *    CONFIGURE time, which is the only point at which it is still cheap.
 *
 * Client-side because it reacts to whatever the admin is typing or has just
 * picked. It is handed the resolved allowlist as plain data rather than reading
 * it: sending-domains.ts resolves from `@/platform/config` at import and must
 * not reach the browser. No domain is named in this file for the same reason no
 * consumer of the allowlist names one.
 */

import { Alert } from "@/platform/ui/alert";
import { domainOf, EMAIL_RE } from "@/platform/email/address";

export type SendingDomainMap = Record<string, "maileroo" | "graph">;

export function SenderIdentityNotes({
  address,
  domains,
  connectedMailbox,
  /** Shown when the address is not on the allowlist at all. Off for a blank field. */
  warnUnsignable = true,
}: {
  address: string | null | undefined;
  domains: SendingDomainMap;
  /** The mailbox Graph is connected as, from mailConnectionStatus(). */
  connectedMailbox: string | null;
  warnUnsignable?: boolean;
}) {
  const normalized = address?.trim().toLowerCase() ?? "";
  if (!normalized) return null;
  const domain = domainOf(normalized);
  const transport = domain ? domains[domain] : undefined;

  // The format half of the server's check (sendingAddressProblem), mirrored here
  // so it is answered while the field is still focused. The domain check below
  // cannot stand in for it: "a b@havenfreeclinic.org" has a perfectly good
  // domain, so without this the admin gets no feedback at all until the server
  // refuses. Same EMAIL_RE the server uses, so the two cannot disagree. The
  // server still decides; this only shortens the loop.
  if (!EMAIL_RE.test(normalized)) {
    if (!warnUnsignable) return null;
    return (
      <Alert tone="error">
        <strong>{normalized}</strong>{" "}
        is not a valid email address, so it cannot be issued.
      </Alert>
    );
  }

  if (!transport) {
    if (!warnUnsignable) return null;
    return (
      <Alert tone="error">
        No transport can sign mail for <strong>{domain ?? normalized}</strong>, so this address
        cannot be used. Choose an address on one of the verified sending domains:{" "}
        {Object.keys(domains).sort().join(", ")}.
      </Alert>
    );
  }

  if (transport !== "graph") return null;

  const isConnectedMailbox =
    connectedMailbox !== null && connectedMailbox.trim().toLowerCase() === normalized;

  return (
    <div className="space-y-2">
      <Alert tone="warning">
        {/* The explicit {" "} after each interpolation is load-bearing, not
            formatting noise: JSX strips the leading whitespace of a text child
            that wraps onto another line, so "{normalized} sends" renders as
            "someone@yale.edusends". Caught by rendering this panel, not by tsc
            or eslint, neither of which can see it. */}
        <strong>Paces out over hours.</strong> {normalized}{" "}
        sends through Microsoft Graph, which inherits Exchange Online&apos;s roughly 30 messages per
        minute cap. A roster-wide campaign from this address takes hours to deliver. The same
        campaign from an address on a Maileroo-signed domain has no comparable per-minute ceiling.
      </Alert>
      {!isConnectedMailbox && (
        <Alert tone="warning">
          <strong>Needs a Send-As grant.</strong> Graph sends every message as the connected
          mailbox
          {connectedMailbox ? (
            <>
              , <strong>{connectedMailbox}</strong>
            </>
          ) : (
            " (none connected yet)"
          )}
          . Sending as {normalized}{" "}
          fails permanently unless Exchange grants that mailbox Send-As rights on it. Confirm it
          with the sender test in Admin &gt; Email before relying on it: the test goes out through
          the real signing path, so a failure there is the same failure a campaign would hit.
        </Alert>
      )}
    </div>
  );
}
