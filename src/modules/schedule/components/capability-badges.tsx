import { Badge } from "@/platform/ui/badge";
// ./catalog, not the package root: the root imports prisma and notify, and pulling
// that server graph into a presentational badge would drag it into any client bundle
// (and any test) that renders one. The catalog module is the pure half by design.
import {
  SPANISH,
  SPANISH_TOP_SCORE,
  interpreterBarFor,
  languageLabel,
  meetsInterpreterBar,
  spanishProficiencyLabel,
} from "@/platform/languages/catalog";

/**
 * Person-level capability badges for a Full Schedule roster row: verified languages
 * and RN.
 *
 * Distinct from the shift tags beside them, which describe the ASSIGNMENT (this
 * person is on triage today). These describe the PERSON and are the same on every
 * date. Both belong on that page because it is where the clinic looks someone up
 * mid-shift, and "who can interpret for this patient" is the question it most often
 * has to answer.
 *
 * Verified only, by construction: fullSchedule never returns a self-reported claim
 * here.
 *
 * Lifted out of the page in audit 14 so the accessible name below is reachable by a
 * test. The page is a server component that authenticates and queries before it
 * renders a single badge, so nothing could assert on this markup while it lived
 * there, which is how a badge whose entire meaning sat in a `title` shipped.
 */
export function CapabilityBadges({
  person,
  department,
}: {
  person: { verifiedLanguages: string[]; licensedRN: boolean; spanishScore?: number | null };
  /**
   * The department this row is being staffed under, whose interpreting bar the
   * Spanish badge is measured against. Omitted on rows that are not
   * department-scoped, where the clinic-wide bar applies.
   */
  department?: { minInterpreterScore: number | null } | null;
}) {
  const bar = interpreterBarFor(department);
  const score = person.spanishScore ?? null;
  // Only a score that is BELOW this department's bar is worth a mark. A score at
  // or above it, and an unscored speaker, both read as a plain verified badge:
  // INTP verified people for years without always writing a number down, and
  // decorating those rows would flag most of the historical roster.
  const spanishBelowBar = score !== null && !meetsInterpreterBar(score, bar);
  return (
    <>
      {/* Code, not the full name: these rows already carry up to four shift tags
          plus a conflict badge, and "Haitian Creole" would wrap every row that has
          one.
          The full name used to live ONLY in `title`, which is a hover tooltip:
          unreachable by keyboard, and not part of the accessible name of a plain
          <span> for most screen readers. On a badge whose visible text is a bare
          two-letter code, that left the whole meaning of the badge available to
          mouse users and nobody else. It now renders as visually-hidden text, so
          it is in the accessible tree unconditionally, and the code is aria-hidden
          so AT reads "Verified: Spanish" instead of spelling out "E S" first.
          `title` stays for the sighted mouse user it does serve.
          Note sr-only is position:absolute, so it is out of flow and adds neither
          width nor a flex gap to the badge. */}
      {person.verifiedLanguages.map((code) => {
        // Spanish carries an INTP proficiency score, and departments differ on
        // what they will staff: 4 clinic-wide, 3 where conversational is enough.
        // A director looking at this row is deciding who interprets for a
        // patient right now, so a speaker below THIS department's bar says so
        // rather than looking identical to one who clears it.
        const flagged = code === SPANISH && spanishBelowBar;
        // The shortfall wins over the tier: it already shows the exact number,
        // so a "+" on top of it would be noise.
        const top = !flagged && code === SPANISH && score === SPANISH_TOP_SCORE;
        const label = flagged
          ? `Verified: ${languageLabel(code)}, assessed ${score} (below this department's bar of ${bar})`
          : top
            ? `Verified: ${languageLabel(code)}, assessed ${score} (${spanishProficiencyLabel(score)})`
            : `Verified: ${languageLabel(code)}`;
        return (
          <Badge key={code} tone={flagged ? "warning" : "brand"} title={label}>
            <span aria-hidden>
              {code.toUpperCase()}
              {flagged ? ` ${score}` : ""}
              {top ? "+" : ""}
            </span>
            <span className="sr-only">{label}</span>
          </Badge>
        );
      })}
      {/* RN is left as plain text on purpose: unlike a two-letter ISO code it is
          already the word people use, and it was never hiding meaning in a title. */}
      {person.licensedRN && <Badge tone="brand">RN</Badge>}
    </>
  );
}
