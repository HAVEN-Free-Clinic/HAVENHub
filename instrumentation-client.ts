import posthog from "posthog-js";
import { isNextControlFlowEvent } from "@/platform/posthog/next-control-flow";
import { isServerRenderEchoEvent } from "@/platform/posthog/server-render-echo";

posthog.init(process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN!, {
  api_host: "/ingest",
  ui_host: "https://us.posthog.com",
  defaults: "2026-01-30",
  capture_exceptions: true,
  // Two kinds of non-error reach the global exception handler and bury the real
  // ones in Error Tracking, so both are dropped before capture: Next's
  // redirect()/notFound() sentinels, which are intended control flow rather than
  // crashes, and React's redacted stand-in for a server-side failure, which
  // duplicates an error the server already reported with its message and stack.
  before_send: (event) =>
    isNextControlFlowEvent(event) || isServerRenderEchoEvent(event)
      ? null
      : event,
  debug: process.env.NODE_ENV === "development",
});
