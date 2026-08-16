import posthog from "posthog-js";
import { isNextControlFlowEvent } from "@/platform/posthog/next-control-flow";
import { isServerRenderEchoEvent } from "@/platform/posthog/server-render-echo";
import { isBrowserExtensionEvent } from "@/platform/posthog/browser-extension";
import { scrubProperties } from "@/platform/posthog/scrub-url";

posthog.init(process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN!, {
  api_host: "/ingest",
  ui_host: "https://us.posthog.com",
  defaults: "2026-01-30",
  capture_exceptions: true,
  // Three kinds of non-error reach the global exception handler and bury the
  // real ones in Error Tracking, so all three are dropped before capture:
  // Next's redirect()/notFound() sentinels, which are intended control flow
  // rather than crashes; React's redacted stand-in for a server-side failure,
  // which duplicates an error the server already reported with its message and
  // stack; and exceptions thrown entirely inside the visitor's own browser
  // extensions, which land on us only because they happened on our page and
  // which no deploy of ours can fix.
  before_send: (event) =>
    isNextControlFlowEvent(event) ||
    isServerRenderEchoEvent(event) ||
    isBrowserExtensionEvent(event)
      ? null
      : event,
  debug: process.env.NODE_ENV === "development",
  // /login/verify, /apply/verify and /onboard/<token> render a page while the
  // token in their URL is still live, so an unfiltered $current_url would ship
  // a replayable credential to PostHog. Redact before anything is sent.
  sanitize_properties: scrubProperties,
});
