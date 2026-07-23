import posthog from "posthog-js";
import { isNextControlFlowEvent } from "@/platform/posthog/next-control-flow";

posthog.init(process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN!, {
  api_host: "/ingest",
  ui_host: "https://us.posthog.com",
  defaults: "2026-01-30",
  capture_exceptions: true,
  // The global exception handler sees Next's redirect()/notFound() sentinels as
  // unhandled rejections during a soft navigation. They are intended control
  // flow, not crashes, so drop them before they reach Error Tracking.
  before_send: (event) => (isNextControlFlowEvent(event) ? null : event),
  debug: process.env.NODE_ENV === "development",
});
