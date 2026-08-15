import { Wrench } from "lucide-react";

/**
 * Persistent strip shown at the very top of every page while maintenance mode
 * is on, rendered from the root layout directly beneath EnvBanner.
 *
 * In practice its only audience is a Platform Admin, since nobody else gets
 * past the gate, and that is the point: the one person who can still use the
 * hub is also the one person who can forget the rest of the clinic cannot.
 *
 * Same one-off treatment as EnvBanner, and inline colors for the same reason:
 * this is an alarm strip that deliberately departs from the neutral surface
 * palette, and the red-700 / red-50 pairing clears WCAG AA in both themes.
 * Non-dismissible.
 */
export function MaintenanceBanner({ enabled }: { enabled: boolean }) {
  if (!enabled) return null;
  return (
    <div
      role="status"
      style={{ backgroundColor: "#b91c1c", color: "#fef2f2" }}
      className="flex items-center justify-center gap-2 px-3 py-1.5 text-center text-sm font-medium"
    >
      <Wrench className="h-4 w-4 shrink-0" aria-hidden />
      <span>
        <span className="font-semibold uppercase tracking-wide">Maintenance mode</span>
        {" · the hub is down for everyone except Platform Admins"}
      </span>
    </div>
  );
}
