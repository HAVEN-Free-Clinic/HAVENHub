/**
 * Canonical Yale affiliation vocabulary (platform-level).
 *
 * Person.yaleAffiliation is written by four surfaces (the /apply recruitment
 * form, the onboarding contract, /my-info, and the admin person editor) and
 * read by four more (EHS training applicability, the YNHH Epic access PDF,
 * email campaign audiences, and the Airtable import). Before this module each
 * side kept its own hand-written list, so the column accumulated three
 * vocabularies and every reader pattern-matched the mixture by hand.
 *
 * This lives in platform, not in modules/recruitment where the list started,
 * because eslint forbids modules from importing each other (my-info and admin
 * may not reach into recruitment) and forbids platform from importing module
 * code at all. src/platform/people.ts sits here for the same reason.
 *
 * Values are stable machine keys; labels are user-facing.
 */

export type AffiliationOption = { value: string; label: string };

/**
 * The one option that means "no Yale account at all".
 *
 * Exported as a constant because it is not just a list entry: the /apply form
 * gates the Yale-only identity questions (NetID) on it, so a rename here has to
 * travel with those conditions rather than silently leaving them pointing at a
 * value nothing can select.
 */
export const NON_YALE_AFFILIATION = "non_yale";

export const YALE_AFFILIATIONS: AffiliationOption[] = [
  { value: "yale_college", label: "Yale College" },
  { value: "divinity", label: "Yale School of Divinity" },
  { value: "gsas", label: "Yale Graduate School of Arts and Sciences (GSAS)" },
  { value: "jackson", label: "Yale Jackson School of Global Affairs" },
  { value: "law", label: "Yale Law School (YLS)" },
  { value: "som", label: "Yale School of Management (SOM)" },
  { value: "ysm_md", label: "Yale School of Medicine (YSM), MD or MD/PhD" },
  { value: "ysm_pa", label: "Yale School of Medicine (YSM), PA" },
  { value: "ysn", label: "Yale School of Nursing (YSN)" },
  { value: "ysph", label: "Yale School of Public Health (YSPH)" },
  { value: "staff", label: "Yale Staff" },
  { value: "other_yale", label: "Other Yale Affiliation" },
  { value: NON_YALE_AFFILIATION, label: "I am NOT a Yale Affiliate" },
];

const LABEL_BY_VALUE = new Map(YALE_AFFILIATIONS.map((o) => [o.value, o.label]));

/**
 * Legacy strings to canonical keys, keyed by lower(trim(...)).
 *
 * Covers every vocabulary that has reached the column: the canonical labels
 * themselves (what Airtable stores and what every form displays), and the eight
 * human strings the retired /my-info dropdown wrote. Keep in sync with the
 * mapping in prisma/migrations/*_normalize_yale_affiliation.
 *
 * "Yale School of Medicine" is deliberately mapped to ysm_md: in the /my-info
 * vocabulary it meant MD, because that list carried "Physician Associate
 * Program" as a separate option.
 */
const LEGACY_TO_CANONICAL = new Map<string, string>([
  ["yale college", "yale_college"],
  ["yale school of medicine", "ysm_md"],
  ["yale school of nursing", "ysn"],
  ["yale school of public health", "ysph"],
  ["physician associate program", "ysm_pa"],
  ["graduate school", "gsas"],
  ["staff", "staff"],
  ["other", "other_yale"],
  ...YALE_AFFILIATIONS.map((o) => [o.label.toLowerCase(), o.value] as [string, string]),
]);

/** Canonical label, the raw string when unrecognized, "" when blank or null. */
export function affiliationLabel(value: string | null | undefined): string {
  const raw = (value ?? "").trim();
  if (raw === "") return "";
  return LABEL_BY_VALUE.get(raw) ?? raw;
}

/**
 * The canonical options, prepending an unrecognized stored value as its own
 * option so that re-saving a form can never silently erase it. The backfill
 * deliberately leaves values it cannot map, and this is what keeps them
 * selectable instead of snapping to the first option in the list.
 */
export function affiliationOptionsWith(current: string | null | undefined): AffiliationOption[] {
  const raw = (current ?? "").trim();
  if (raw === "" || LABEL_BY_VALUE.has(raw)) return YALE_AFFILIATIONS;
  return [{ value: raw, label: raw }, ...YALE_AFFILIATIONS];
}

/**
 * Legacy string to canonical key. Null, undefined, and whitespace-only inputs
 * return null. Any other string with no mapping is returned trimmed but
 * otherwise unchanged, never nulled.
 */
export function normalizeAffiliation(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return null;
  if (LABEL_BY_VALUE.has(trimmed)) return trimmed;
  return LEGACY_TO_CANONICAL.get(trimmed.toLowerCase()) ?? trimmed;
}

/**
 * Non-students: Yale staff, an unspecified "other" Yale affiliation, people who
 * are not Yale-affiliated at all, and blank. Every named Yale school is a
 * student.
 *
 * Matched case-insensitively against the canonical keys AND the legacy lowercase
 * forms, because the backfill deliberately leaves values it cannot map and
 * misclassifying one assigns the wrong bloodborne-pathogen training.
 */
const NON_STUDENT_AFFILIATIONS = new Set([
  "staff",
  "other_yale",
  NON_YALE_AFFILIATION,
  "yale staff",
  "other yale affiliation",
  "other",
  "i am not a yale affiliate",
]);

export function isStudentAffiliation(value: string | null | undefined): boolean {
  const a = (value ?? "").trim().toLowerCase();
  return a !== "" && !NON_STUDENT_AFFILIATIONS.has(a);
}

const MEDICAL_SCHOOL_AFFILIATIONS = new Set(["ysm_md", "ysm_pa"]);

/** Both YSM tracks. Used by the YNHH Epic PDF to check its "Med Student" box. */
export function isMedicalSchoolAffiliation(value: string | null | undefined): boolean {
  return MEDICAL_SCHOOL_AFFILIATIONS.has((value ?? "").trim().toLowerCase());
}
