import posthog from "posthog-js";
import { isNextControlFlowEvent } from "@/platform/posthog/next-control-flow";
import { isServerRenderEchoEvent } from "@/platform/posthog/server-render-echo";
import { isBrowserExtensionEvent } from "@/platform/posthog/browser-extension";
import { isRecoverableHydrationEvent } from "@/platform/posthog/react-hydration";
import { isScriptErrorEvent } from "@/platform/posthog/script-error";
import { isAuthSessionPollEvent } from "@/platform/posthog/auth-session-poll";
import { isNativeControlDeadClickEvent } from "@/platform/posthog/native-control-dead-click";
import { scrubProperties } from "@/platform/posthog/scrub-url";

posthog.init(process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN!, {
  api_host: "/ingest",
  ui_host: "https://us.posthog.com",
  defaults: "2026-01-30",
  capture_exceptions: true,
  // Six kinds of non-error reach the global exception handler and bury the real
  // ones in Error Tracking, so all six are dropped before capture:
  // Next's redirect()/notFound() sentinels, which are intended control flow
  // rather than crashes; React's redacted stand-in for a server-side failure,
  // which duplicates an error the server already reported with its message and
  // stack; exceptions thrown entirely inside the visitor's own browser
  // extensions, which land on us only because they happened on our page and
  // which no deploy of ours can fix; React's recoverable hydration mismatches,
  // which React fixes by re-rendering before anyone sees them and which arrive
  // with no element, component, or stack to act on; the browser's opaque
  // cross-origin "Script error." report, which the browser strips of message,
  // source, and stack and which nothing we ship can produce; and next-auth's
  // background session poll losing its fetch to a network blip, which changes
  // nothing the member can see because the session cookie is unaffected and the
  // next poll reconciles.
  //
  // The bar is "nothing is actually broken", NOT "this message is noisy". An
  // opaque exception that IS the only evidence of a user-facing failure stays --
  // see the /my-info oversized-upload error, which is deliberately not filtered
  // here and is fixed at the source instead.
  //
  // The last predicate is not an exception filter: it drops `$dead_click` events
  // on native `<select>`, `<textarea>`, and text-entry `<input>` controls, which
  // the recorder mislabels as dead because opening a dropdown or focusing a field
  // mutates no DOM. It is the same "nothing is actually broken" bar applied to
  // the dead-click signal, and it keeps toggle, label, and button dead clicks --
  // the ones that carry real friction.
  before_send: (event) =>
    isNextControlFlowEvent(event) ||
    isServerRenderEchoEvent(event) ||
    isBrowserExtensionEvent(event) ||
    isRecoverableHydrationEvent(event) ||
    isScriptErrorEvent(event) ||
    isAuthSessionPollEvent(event) ||
    isNativeControlDeadClickEvent(event)
      ? null
      : event,
  debug: process.env.NODE_ENV === "development",
  // /login/verify, /apply/verify and /onboard/<token> render a page while the
  // token in their URL is still live, so an unfiltered $current_url would ship
  // a replayable credential to PostHog. Redact before anything is sent.
  sanitize_properties: scrubProperties,
});
