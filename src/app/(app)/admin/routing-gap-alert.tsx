/**
 * The transport-migration warning, rendered wherever the flip is decided or its
 * inputs are edited.
 *
 * ONE component for two surfaces on purpose. /admin/settings is where someone
 * changes email.transport and /admin/email is where the addresses it moves are
 * typed; two hand-written cards would drift, and the one that drifted would be
 * the one someone read on the day it mattered. The `where` prop only changes the
 * pointer at the OTHER surface, never the facts.
 *
 * A warning, not a block. See routing-gap.ts: an operator is allowed to decide
 * that every one of these should move to Maileroo. What they must not do is
 * decide it by accident.
 *
 * No "use client": both callers are Server Components and this renders no
 * interactivity, so the list of addresses never ships to the browser.
 */
import Link from "next/link";
import { Alert } from "@/platform/ui/alert";
import type { EmailRoutingGap } from "@/platform/email/routing-gap";

export function RoutingGapAlert({
  gap,
  where,
}: {
  /** Null when the check could not run (a database blip); renders nothing. */
  gap: EmailRoutingGap | null;
  /** Which page this is on, so the copy can point at the other one. */
  where: "settings" | "email";
}) {
  if (!gap) return null;

  // Under "log" nothing is delivered at all, so there is no transport to move
  // mail off and the card would be noise on every developer's machine. The
  // hazard is real under "graph" (it has not happened yet) and the record is
  // useful under "maileroo" (it already has).
  if (gap.transport === "log") return null;

  const globalSenderMoves = gap.globalSender !== null && !gap.globalSender.graphRouted;

  // Nothing configured moves, and nothing to say. The all-clear is deliberately
  // silent rather than a green card: an admin page that congratulates itself on
  // every load trains people to skip its boxes, including the one that matters.
  if (gap.entries.length === 0 && !globalSenderMoves) return null;

  const alreadyOnMaileroo = gap.transport === "maileroo";
  const count = gap.entries.length;

  return (
    // The gap below it, not a wrapper above it, so that rendering NOTHING really
    // is nothing. A wrapping spacer div in the caller would leave a stripe of
    // padding on every settings page whose addresses are all fine. The settings
    // card has no space-y of its own; /admin/email's does, so it needs none.
    <Alert tone="warning" className={where === "settings" ? "mb-3" : undefined}>
      <p className="font-medium">
        {alreadyOnMaileroo
          ? "This mail is going out through Maileroo, not Graph."
          : "Switching the email transport to Maileroo would move this mail off Graph."}
      </p>
      <p className="mt-1">
        {alreadyOnMaileroo ? (
          <>
            Email transport is set to Maileroo, so every send-from address below leaves through
            Maileroo rather than the Yale mailbox. It arrives at yale.edu as external mail.
          </>
        ) : (
          <>
            Email transport is currently <strong>{gap.transport}</strong>, so nothing is routed by
            address yet. The moment it is set to Maileroo, every address below changes transport
            silently: no error, no failed row, and mail that Exchange sends inside the Yale tenant
            today starts arriving at yale.edu inboxes as external mail.
          </>
        )}{" "}
        To keep an address on Graph, add it to the <code>GRAPH_SENDER_ADDRESSES</code> environment
        variable and redeploy. Graph can only send as a mailbox that lives in the Microsoft tenant,
        so a personal Yale address cannot go on that list; a shared clinic mailbox can.
      </p>
      {count > 0 && (
        <ul className="mt-2 space-y-1">
          {gap.entries.map((entry) => (
            <li key={entry.address}>
              <strong>{entry.address}</strong>{" "}
              <span className="text-muted-foreground">({entry.usedBy.join(", ")})</span>
            </li>
          ))}
        </ul>
      )}
      {/* The global default is not a sender rule, so it is not in the list above,
          but it is the From for every category with no rule -- including
          authentication, which is magic-link logins. Naming the moving rules
          while login mail moved unmentioned would understate the blast radius. */}
      {globalSenderMoves && gap.globalSender && (
        <p className="mt-2">
          The global default <strong>{gap.globalSender.address}</strong> moves too. It is the
          send-from address for every category with no rule of its own, authentication (magic-link
          logins) among them.
        </p>
      )}
      {gap.graphRoutedCount > 0 && (
        <p className="mt-2 text-muted-foreground">
          {gap.graphRoutedCount} other send-from{" "}
          {gap.graphRoutedCount === 1 ? "address stays" : "addresses stay"} on Graph.
        </p>
      )}
      <p className="mt-2">
        {where === "settings" ? (
          <Link href="/admin/email" className="underline underline-offset-2">
            Review the send-from addresses
          </Link>
        ) : (
          <Link href="/admin/settings" className="underline underline-offset-2">
            Change the email transport in Settings
          </Link>
        )}
      </p>
    </Alert>
  );
}
