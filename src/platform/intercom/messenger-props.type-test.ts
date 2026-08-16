/**
 * Type-level guard on IntercomMessenger's props. No runtime assertions -- the
 * checking happens when `tsc --noEmit` runs over this file in CI.
 *
 * WHY THIS FILE EXISTS, and why the guard is not simply a comment:
 *
 * IntercomMessenger's 401/403-to-visitor fallback is guarded on `!booted`, and a
 * server-minted `initialToken` sets `booted` at mount. So on a surface that
 * passes both `requireActiveMembership` and `initialToken`, the gate's
 * client-side half is unreachable BY CONSTRUCTION -- it cannot fire, because the
 * tab already booted. The /apply portal's gate would silently become nothing,
 * and a Yale account with no active term membership would boot identified, with
 * no error raised anywhere and nothing in any log to notice it by.
 *
 * That is not a bug a test can catch after the fact, because there is no
 * failing behaviour to observe: the widget works, it just trusts the wrong
 * person. So the combination is made unsayable in the type system instead.
 *
 * HOW THIS FAILS: `@ts-expect-error` is an error itself when the line beneath it
 * has no error. If someone widens IntercomMessengerProps so the forbidden
 * combination type-checks, the directive below becomes unused and `tsc` fails
 * with "Unused '@ts-expect-error' directive". Deleting the guard therefore
 * breaks the build rather than passing quietly, which is the only property that
 * makes this worth having.
 */
import { createElement } from "react";
import { IntercomMessenger } from "./messenger";

const TOKEN = { token: "signed.jwt", expiresInSeconds: 900 };

// The three legitimate shapes, one per union member. These must keep compiling.
export const visitor = createElement(IntercomMessenger, { appId: "abc123", mode: "visitor" });

export const identifiedWithServerToken = createElement(IntercomMessenger, {
  appId: "abc123",
  mode: "identified",
  initialToken: TOKEN,
});

export const identifiedGated = createElement(IntercomMessenger, {
  appId: "abc123",
  mode: "identified",
  requireActiveMembership: true,
});

// THE GUARD. A gated surface must not also boot from a server-minted token: see
// the file comment. If this stops erroring, the gate has been quietly defeated.
export const gatedWithServerToken = createElement(IntercomMessenger, {
  appId: "abc123",
  mode: "identified",
  requireActiveMembership: true,
  // @ts-expect-error initialToken makes the client-side membership gate unreachable
  initialToken: TOKEN,
});

// Visitor mode carries no identity, so neither identity-shaped prop is sayable
// there either -- both would read as "this anonymous boot is somehow gated".
export const visitorWithToken = createElement(IntercomMessenger, {
  appId: "abc123",
  mode: "visitor",
  // @ts-expect-error visitor mode boots with no token at all
  initialToken: TOKEN,
});
