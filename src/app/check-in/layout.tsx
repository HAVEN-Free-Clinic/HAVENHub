import type { ReactNode } from "react";

/**
 * The door.
 *
 * A top-level route rather than one inside the `(app)` group, and that is the
 * whole content of this file: leaving the group is what drops AppShell, so the
 * screen has no module nav, no breadcrumbs, and nothing else to click. For the
 * length of a training session this laptop is a check-in terminal that somebody
 * borrowed, often turned toward a queue, and every tab in a sidebar is a way to
 * lose the operator's place in it.
 *
 * Everything a page actually needs -- fonts, theme (including the no-flash dark
 * mode script), the toast viewport -- already comes from the root layout, which
 * is why this adds no chrome of its own. `/get-started` is the same shape for
 * the same reason.
 *
 * Authentication is NOT skipped by living out here: every page below calls
 * requirePersonSession, which is the app's real chokepoint (a layout does not
 * re-render on soft navigation, so gates in one are bypassable -- see the
 * onboarding gate). Authority to record attendance is checked in the page too.
 */
export default function CheckInLayout({ children }: { children: ReactNode }) {
  return <div className="min-h-screen bg-canvas">{children}</div>;
}
