import type { ReactNode } from "react";

/**
 * Page entrance for the signed-in app. A template remounts when the segment
 * under it changes, so moving between modules (Schedule to Admin) replays the
 * fade-and-rise on the main area while the shell (toolbar, breadcrumbs) holds
 * still. Moving between a module's own tabs does not remount it; the tab
 * row's sliding indicator marks that change instead.
 *
 * CSS rather than Motion, so this stays a server component. The animation's
 * transform and filter would capture a `fixed` descendant while it runs, which
 * is safe here because every fixed overlay in the app (Modal, CommandPalette,
 * toasts, BlockerGate) portals to document.body. Keep it that way.
 */
export default function AppTemplate({ children }: { children: ReactNode }) {
  return <div className="motion-safe:animate-page-in">{children}</div>;
}
