/**
 * A person's name, with a verified badge when they are cleared to work.
 *
 * "Cleared" means exactly what the compliance roster already labels Cleared:
 * every onboarding requirement satisfied for the ACTIVE term (profile, HIPAA,
 * training, learning, EHS). Resolve it with loadClearedSet (platform/clearance),
 * once per page, and pass the boolean in. This component NEVER fetches: it
 * renders beside names in tables and lists, and a self-fetching badge would turn
 * a forty-row roster into hundreds of queries.
 *
 * THE BADGE IS POSITIVE-ONLY, and that is a privacy decision rather than a
 * stylistic one. A "not cleared" marker would broadcast that someone's HIPAA
 * certificate or training is outstanding to every colleague who sees their name
 * on a schedule. That belongs to the compliance roster, where the people
 * responsible for it can act on it. Here, absence of a badge says nothing at
 * all, and an uncleared person is indistinguishable from one whose clearance was
 * never looked up.
 *
 * Callers gate visibility separately: page loaders skip loadClearedSet entirely
 * unless the viewer holds volunteers.view, so a regular volunteer both sees no
 * badges and costs no extra queries.
 */

import { cx } from "./cx";

type PersonNameProps = {
  /** Person.name, which is nullable in the schema. */
  name: string | null;
  /** Whether this person is cleared. Omit when the viewer may not see clearance. */
  cleared?: boolean;
  className?: string;
};

export function PersonName({ name, cleared = false, className }: PersonNameProps) {
  const label = name?.trim() || "Unknown";
  if (!cleared) return <span className={className}>{label}</span>;

  return (
    <span className={cx("inline-flex items-center gap-1", className)}>
      {label}
      {/* role="img" + <title>: the badge carries meaning, so it needs an
          accessible name. Without one a screen reader announces the name and
          silently drops the status the sighted user can see.

          The seal is a 14-lobe scalloped circle generated from polar geometry
          (notch points at 0.925 of the outer radius, joined by quadratic curves
          through control points on each bisector), so it is symmetric by
          construction. The previous path was hand-written and visibly lopsided.
          14 lobes is deliberate: fewer reads as a cloud, more collapses into a
          plain circle at the 14px this actually renders at.

          The tick is a HOLE, not a painted shape -- one path, fillRule
          "evenodd". Painting it a fixed colour would break wherever the badge
          sits on something other than that colour: card, striped table row,
          dark mode. As a knockout it simply shows whatever is behind it. */}
      <svg
        role="img"
        aria-label="Cleared for clinic"
        viewBox="0 0 24 24"
        fill="currentColor"
        className="h-3.5 w-3.5 shrink-0 text-success"
      >
        <title>Cleared for clinic</title>
        <path
          fillRule="evenodd"
          d="M12 1.45Q14.79 -0.21 16.58 2.5Q19.81 2.21 20.24 5.43Q23.28 6.57 22.28 9.65Q24.52 12 22.28 14.35Q23.28 17.43 20.24 18.57Q19.81 21.79 16.58 21.5Q14.79 24.21 12 22.55Q9.21 24.21 7.42 21.5Q4.19 21.79 3.76 18.57Q0.72 17.43 1.72 14.35Q-0.52 12 1.72 9.65Q0.72 6.57 3.76 5.43Q4.19 2.21 7.42 2.5Q9.21 -0.21 12 1.45ZM6.27 12.2L10.6 16.53L17.93 9.2L16.3 7.57L10.6 13.27L7.9 10.57Z"
        />
      </svg>
    </span>
  );
}
