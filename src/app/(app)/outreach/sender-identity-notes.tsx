"use client";

/**
 * The two things about a sending identity that are invisible unless the UI says
 * them out loud, shown wherever an identity is CHOSEN or CONFIGURED rather than
 * buried in a doc. Both were discovered the expensive way.
 *
 * Both apply to any address that is ROUTED to Graph, which is why the branch
 * below tests the transport rather than naming a domain. Two rules can put it
 * there, and this panel deliberately does not care which: GRAPH_SENDER_ADDRESSES
 * names the address (or it IS the connected mailbox), or SENDING_DOMAINS routes
 * its whole domain. As of 2026-09-02 no domain does, so before address-level
 * routing this panel was inert; a deployment that lists its shared mailboxes
 * puts real addresses through it.
 *
 * IT MUST RUN THE SEND PATH'S OWN PRECEDENCE, not a domain lookup of its own.
 * That is the bug this file had the moment addresses could out-rank domains: it
 * read the domain map alone, so hfc.admin@yale.edu -- a mailbox Graph carries,
 * on a domain the map calls Maileroo-signed -- got neither warning, and a
 * roster-wide campaign from it would silently pace out over hours against a cap
 * nobody was told about. decideSigningTransport lives in the dependency-free
 * ./address module for exactly this reason: one implementation, shared with the
 * router, so configure time and send time cannot disagree.
 *
 * 1. THE GRAPH THROUGHPUT CEILING. A Graph-routed identity inherits Exchange
 *    Online's roughly 30 messages per minute submission cap. That ceiling is the
 *    reason MailerooTransport exists at all. A roster-wide campaign from such an
 *    identity paces out over hours; the same campaign from a Maileroo-signed
 *    domain does not. Nothing in the send path surfaces this: the campaign just
 *    appears to be taking a long time.
 *
 * 2. THE SEND-AS REQUIREMENT. Graph sends as the one connected mailbox's
 *    delegated session. An address that mailbox has no Exchange Send-As grant on
 *    fails PERMANENTLY. Task 1 made that failure legible at send time; this
 *    makes it visible at CONFIGURE time, which is the only point at which it is
 *    still cheap.
 *
 * Client-side because it reacts to whatever the admin is typing or has just
 * picked. It is handed the resolved allowlist as plain data rather than reading
 * it: sending-domains.ts resolves from `@/platform/config` at import and must
 * not reach the browser. No domain is named in this file for the same reason no
 * consumer of the allowlist names one.
 */

import { Alert } from "@/platform/ui/alert";
import { decideSigningTransport, EMAIL_RE } from "@/platform/email/address";

export type SendingDomainMap = Record<string, "maileroo" | "graph">;

export function SenderIdentityNotes({
  address,
  domains,
  graphAddresses,
  connectedMailbox,
  /** Shown when the address is not on the allowlist at all. Off for a blank field. */
  warnUnsignable = true,
}: {
  address: string | null | undefined;
  domains: SendingDomainMap;
  /**
   * GRAPH_SENDER_ADDRESSES as plain data, for the same reason `domains` is: the
   * module that resolves it reads `@/platform/config` at import and must not
   * reach the browser.
   */
  graphAddresses: string[];
  /** The mailbox Graph is connected as, from mailConnectionStatus(). */
  connectedMailbox: string | null;
  warnUnsignable?: boolean;
}) {
  const normalized = address?.trim().toLowerCase() ?? "";
  if (!normalized) return null;
  // The router's decision, not a domain lookup. The connected mailbox is passed
  // because Graph can always send as it, which is exactly the case the Send-As
  // warning below then suppresses.
  const transport = decideSigningTransport(normalized, {
    graphAddresses: new Set(graphAddresses.map((a) => a.trim().toLowerCase())),
    domains: new Map(Object.entries(domains)),
    graphMailbox: connectedMailbox,
  })?.transport;

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
        No transport can sign mail for <strong>{normalized}</strong>, so this address cannot be
        used. Choose an address on one of the verified sending domains (
        {Object.keys(domains).sort().join(", ")}), or ask an admin to add this mailbox to{" "}
        <code>GRAPH_SENDER_ADDRESSES</code> if Microsoft Graph holds it.
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
