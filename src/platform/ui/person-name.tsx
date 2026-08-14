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
          silently drops the status the sighted user can see. */}
      <svg
        role="img"
        aria-label="Cleared for clinic"
        viewBox="0 0 20 20"
        fill="currentColor"
        className="h-3.5 w-3.5 shrink-0 text-success"
      >
        <title>Cleared for clinic</title>
        <path
          fillRule="evenodd"
          d="M10 1.5l2.1 1.6 2.6-.2.9 2.5 2.2 1.4-.9 2.5.9 2.5-2.2 1.4-.9 2.5-2.6-.2L10 18.5l-2.1-1.6-2.6.2-.9-2.5L2.2 13l.9-2.5-.9-2.5 2.2-1.4.9-2.5 2.6.2L10 1.5zm3.6 6.3a.75.75 0 00-1.1-1l-3.2 3.5-1.4-1.4a.75.75 0 10-1.1 1.1l2 2a.75.75 0 001.1 0l3.7-4.2z"
          clipRule="evenodd"
        />
      </svg>
    </span>
  );
}
