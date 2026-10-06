import type { ReactNode } from "react";

/**
 * Page entrance for the onboarding steps: each step (profile, HIPAA, training,
 * learning) and the checklist they return to fades and rises in. See
 * (app)/template.tsx for why this is CSS and why it is safe around `fixed`.
 */
export default function GetStartedTemplate({ children }: { children: ReactNode }) {
  return <div className="motion-safe:animate-page-in">{children}</div>;
}
