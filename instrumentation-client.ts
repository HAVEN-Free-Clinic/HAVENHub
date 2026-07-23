import posthog from "posthog-js";
import { isNextControlFlowEvent } from "@/platform/posthog/next-control-flow";

posthog.init(process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN!, {
  api_host: "/ingest",
  ui_host: "https://us.posthog.com",
  defaults: "2026-01-30",
  capture_exceptions: true,
  // Drop Next.js redirect()/notFound() sentinels the global handler picks up as
  // unhandled rejections — they are intended control flow, not errors.
  before_send: (event) => (isNextControlFlowEvent(event) ? null : event),
  debug: process.env.NODE_ENV === "development",
});
