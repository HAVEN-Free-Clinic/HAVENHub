"use client";

import { useSyncExternalStore } from "react";

/**
 * Tracks whether the Intercom Messenger's widget script actually loaded in this
 * tab, so a caller can offer the Messenger when it is up and email when it is
 * not.
 *
 * The SDK gives no readiness signal of its own. Every method call (show,
 * showNewMessage) is pushed onto a queue held on window.Intercom, and if the
 * widget script never arrives it stays queued forever behind a single
 * console.warn -- see messenger-actions.tsx, which documents the same trap. A
 * control wired straight to showNewMessage therefore looks alive and does
 * nothing. That is the wrong failure anywhere, and the worst possible one on
 * the sign-in page, where whoever clicks it is already locked out and has no
 * other way to reach a human.
 *
 * So this watches the one thing the browser reports plainly: the load and error
 * events on the <script> the SDK injects. A content blocker rejects that
 * request (ERR_BLOCKED_BY_CLIENT), which fires `error`; so does a DNS failure,
 * or a network that rejects widget.intercom.io outright. Any of those means the
 * Messenger is not coming.
 *
 * Deliberately NOT the content-blocker probe (./blocker-probe). That one exists
 * to justify a hard, undismissable gate, so it spends three requests and a
 * confirmation round proving a block against a control before it will accuse
 * anyone. Here the cost of being wrong is a mailto link instead of a chat
 * window, and the answer is already sitting in an event the page fires for
 * free. Nothing in this file should grow into a second probe.
 */

/**
 * The id @intercom/messenger-js-sdk gives the script element it injects
 * (`scriptElementId` in its instance-manager). This is someone else's
 * implementation detail, so it is pinned in one place with the reason: the
 * alternative is issuing our own request to widget.intercom.io purely to learn
 * what the browser already knows about the request it just made.
 *
 * If an SDK upgrade renames it, this module degrades to "pending" forever,
 * which callers read as unreachable -- the mailto fallback. Losing chat is the
 * safe direction for that failure, not a dead control.
 */
const SDK_SCRIPT_ID = "_intercom_npm_loader";

/**
 * "pending" is the honest third state, not a synonym for either answer: the
 * script is in flight and we do not yet know. Callers must treat it as "no
 * Messenger" -- it is also the state a tab with the integration switched off
 * stays in forever, since nothing ever injects a script to watch.
 */
export type MessengerReadiness = "pending" | "ready" | "unreachable";

let readiness: MessengerReadiness = "pending";
let watching = false;
const listeners = new Set<() => void>();

/**
 * The first verdict wins, permanently. A script element fires load or error,
 * never both, so this guard is not about the normal path -- it is about making
 * the state one-way by construction. Nothing that arrives afterwards (a
 * duplicate listener, a stray dispatched event, a later watch call) can revoke
 * a Messenger that demonstrably loaded, and nothing can promote one that
 * demonstrably did not. There is no recovery to model either way: the SDK does
 * not re-request a script it failed to fetch, so a blocked widget stays blocked
 * until the page reloads.
 */
function settle(next: MessengerReadiness): void {
  if (readiness !== "pending") return;
  readiness = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Listeners are attached once and never removed. The script element lives for
 * the life of the page (shutdown() clears the Intercom session but leaves the
 * tag behind), the handlers only write a module-level variable, and detaching
 * on unmount would open a race that costs more than it saves: React StrictMode
 * mounts, cleans up, and mounts again, so a load that landed in that gap would
 * be missed and the Messenger would look unreachable for the rest of the page.
 */
function attach(script: HTMLScriptElement): void {
  script.addEventListener("load", () => settle("ready"), { once: true });
  script.addEventListener("error", () => settle("unreachable"), { once: true });
}

/**
 * Start watching the widget script. Call immediately after the `Intercom()`
 * that boots the widget, never before: the SDK only injects the script during
 * that call, and a watcher that ran first would find nothing.
 *
 * Idempotent, so the three boot paths in ./messenger (visitor, identified, and
 * the 401/403 fallback to visitor) can each call it without coordinating.
 */
export function watchMessengerScript(): void {
  if (watching || typeof document === "undefined") return;
  watching = true;

  const script = document.getElementById(SDK_SCRIPT_ID);
  if (script instanceof HTMLScriptElement) {
    attach(script);
    return;
  }

  // The SDK defers injecting until the document is ready, and streaming SSR can
  // hydrate -- and so run the mount effect that calls us -- while readyState is
  // still "loading". Wait on the SDK's own trigger rather than polling. Our
  // listener is registered after the SDK's, so by the time this runs the SDK
  // handler for the same event has already inserted the tag.
  document.addEventListener("readystatechange", function retry() {
    const late = document.getElementById(SDK_SCRIPT_ID);
    if (!(late instanceof HTMLScriptElement)) return;
    document.removeEventListener("readystatechange", retry);
    attach(late);
  });
}

/**
 * Subscribe to the readiness of the Messenger widget.
 *
 * The server snapshot is always "pending", so the first client render matches
 * the server and only later transitions re-render.
 */
export function useMessengerReadiness(): MessengerReadiness {
  return useSyncExternalStore(
    subscribe,
    () => readiness,
    () => "pending" as const,
  );
}
