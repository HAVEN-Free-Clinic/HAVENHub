import { isoDateKey, formatCalendarDate } from "@/platform/dates";
import type { TemplateOption } from "./types";
// The key is defined in platform, not here. It used to be a literal in this
// file that promotion.ts had to be kept "in step" with by hand; the schedule
// builder now reads the same answer as well, and a module may not import
// another module, so the one definition lives on the side all three reach.
import { AVAILABILITY_FIELD_KEY } from "@/platform/recruitment/incoming-roster";

/**
 * The term's admin-curated clinic calendar (Term.clinicDates) as MULTI_SELECT
 * options for the application's availability question.
 *
 * `value` is the UTC day key: it is what parseAvailabilityDates expects and what
 * the scheduler compares baselineAvailability on. The weekday is part of the
 * label because clinic dates are curated, not generated, so they are no longer
 * guaranteed to fall on a Saturday.
 *
 * Pass OPEN dates only. Closure is a flag on `ClinicDay`, not a deletion from
 * `Term.clinicDates`, so a closed Saturday is still in the array a loader reads;
 * every loader runs it through `openClinicDates` first. This function stays pure
 * and takes the filtered list rather than doing the join itself.
 */
export function clinicDateOptions(clinicDates: Date[]): TemplateOption[] {
  return [...clinicDates]
    .sort((a, b) => a.getTime() - b.getTime())
    .map((d) => ({
      value: isoDateKey(d),
      label: formatCalendarDate(d, { weekday: "short", month: "short", day: "numeric" }),
    }));
}


type ResolvableField = { key: string; options: unknown };
type ResolvableSection<F> = { fields: F[] };

/**
 * Replace the availability field's stored options with the term's live clinic
 * calendar. The stored FormField.options snapshot is deliberately ignored:
 * cycles are created before the calendar is finalized, so the snapshot is stale
 * by design.
 *
 * An empty calendar means the dates are genuinely unknown, so the question is
 * removed rather than rendered with zero options. Leaving it would strand the
 * applicant on a required field with nothing to select. The containing section
 * is removed only if that leaves it empty, so a director who added their own
 * fields to the Availability section does not lose them.
 */
export function resolveAvailabilityOptions<
  F extends ResolvableField,
  S extends ResolvableSection<F>,
>(sections: S[], clinicDates: Date[]): S[] {
  const options = clinicDateOptions(clinicDates);
  const out: S[] = [];
  for (const section of sections) {
    if (!section.fields.some((f) => f.key === AVAILABILITY_FIELD_KEY)) {
      out.push(section);
      continue;
    }
    // The `as F` / `as S` casts are load-bearing: spreading a generic produces a
    // widened anonymous type that TypeScript will not accept as F or S, even
    // though only `options` changed and the constraint declares it `unknown`.
    if (options.length > 0) {
      out.push({
        ...section,
        fields: section.fields.map((f) => (f.key === AVAILABILITY_FIELD_KEY ? ({ ...f, options } as F) : f)),
      } as S);
      continue;
    }
    const remaining = section.fields.filter((f) => f.key !== AVAILABILITY_FIELD_KEY);
    if (remaining.length > 0) out.push({ ...section, fields: remaining } as S);
  }
  return out;
}
