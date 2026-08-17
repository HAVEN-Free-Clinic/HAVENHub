"use client";

import type { MouseEvent, ReactNode } from "react";
import { showNewMessage } from "@intercom/messenger-js-sdk";
import { supportLinkClasses } from "@/platform/branding/support-link";
import { useMessengerReadiness } from "./messenger-readiness";

/**
 * The support contact on a signed-out surface: opens the Intercom Messenger
 * when the Messenger is actually up, and emails when it is not.
 *
 * A drop-in for SupportLink, and deliberately still an `<a href="mailto:">` in
 * every state rather than a button that appears once the widget loads. Three
 * reasons, all of which weigh more here than on a signed-in page:
 *
 *   - Whoever clicks this is locked out. The mailto is the floor, and it holds
 *     up where the enhancement cannot: widget blocked, script still loading,
 *     JavaScript broken, middle-click, or "copy email address" from the context
 *     menu.
 *   - Nothing on the page moves. A control that turned into a button (or
 *     relabelled itself) when the widget finished loading would reflow the card
 *     under someone mid-read, seconds after it settled, for no gain.
 *   - The visible text says "contact", which is honest for both outcomes, so
 *     the accessible name never has to disagree with what the click does.
 *
 * Until the widget reports in, a click emails: "pending" is not "ready" (see
 * ./messenger-readiness). That window is the first moment of the page's life,
 * before anyone has tried to sign in, failed, and gone looking for help -- and
 * erring that way is the safe direction, since the worst case is an email to
 * the address written right there in the link.
 */
export function MessengerSupportLink({ email, children }: { email: string; children: ReactNode }) {
  const readiness = useMessengerReadiness();

  // Same blank-handling as SupportLink, so the two stay interchangeable at every
  // call site. A surface with no support email configured shows no contact at
  // all rather than one nobody can reach.
  if (!email) return <>{children}</>;

  function openMessenger(event: MouseEvent<HTMLAnchorElement>) {
    if (readiness !== "ready") return;
    // Let the browser have the clicks that mean "not here": a modified click is
    // a request for the href itself, and honoring it with a chat window would
    // be a worse surprise than the mailto they asked for.
    if (event.defaultPrevented) return;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    // Straight into a fresh composer rather than the Messenger home, matching
    // AskInMessengerButton: someone who cannot sign in needs to describe that to
    // a person, not land on a help-article index.
    showNewMessage("");
  }

  return (
    <a href={`mailto:${email}`} className={supportLinkClasses} onClick={openMessenger}>
      {children}
    </a>
  );
}
