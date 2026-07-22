import { AlertTriangle } from "lucide-react";

/**
 * Persistent non-production notice, rendered at the very top of every page from
 * the root layout when `config.ENV_BANNER_LABEL` is set (e.g. on staging), so a
 * user can never mistake the deploy for production. Renders nothing when the
 * label is empty, which is the production case.
 *
 * Deliberately amber in both light and dark themes: a warning should stay a
 * warning. The color is inline (not a semantic token) because this is a one-off
 * alarm strip that intentionally departs from the neutral surface palette, and
 * the amber-500 / amber-950 pairing clears WCAG AA. Non-dismissible.
 */
export function EnvBanner({ label }: { label?: string | null }) {
  if (!label) return null;
  return (
    <div
      role="status"
      style={{ backgroundColor: "#f59e0b", color: "#451a03" }}
      className="flex items-center justify-center gap-2 px-3 py-1.5 text-center text-sm font-medium"
    >
      <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
      <span>
        <span className="font-semibold uppercase tracking-wide">{label}</span>
        {" · not production data"}
      </span>
    </div>
  );
}
