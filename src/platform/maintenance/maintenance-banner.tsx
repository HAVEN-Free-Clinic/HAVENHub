import { Wrench } from "lucide-react";

/**
 * Persistent strip shown at the top of the page to someone browsing the hub
 * during a maintenance window, rendered from the root layout directly beneath
 * EnvBanner. The one person who can still use the hub is also the one person
 * who can forget the rest of the clinic cannot.
 *
 * Its audience is enforced by shouldShowMaintenanceBanner, not assumed. The
 * surfaces that stay up during a window are reachable by members, applicants,
 * and anyone at all (a public passport link), so mounting this on the switch
 * alone shows an internal operations notice to people it is not for.
 *
 * The copy names who is affected rather than who is exempt, for the same
 * reason: "everyone except Platform Admins" describes our role structure, and
 * a banner should not be where that gets published.
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
        {" · the hub is offline for members"}
      </span>
    </div>
  );
}
