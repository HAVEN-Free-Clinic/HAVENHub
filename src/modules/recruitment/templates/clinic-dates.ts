import { isoDateKey, formatCalendarDate } from "@/platform/dates";
import type { TemplateOption } from "./types";

/**
 * The term's admin-curated clinic calendar (Term.clinicDates) as MULTI_SELECT
 * options for the application's availability question.
 *
 * `value` is the UTC day key: it is what parseAvailabilityDates expects and what
 * the scheduler compares baselineAvailability on. The weekday is part of the
 * label because clinic dates are curated, not generated, so they are no longer
 * guaranteed to fall on a Saturday.
 */
export function clinicDateOptions(clinicDates: Date[]): TemplateOption[] {
  return [...clinicDates]
    .sort((a, b) => a.getTime() - b.getTime())
    .map((d) => ({
      value: isoDateKey(d),
      label: formatCalendarDate(d, { weekday: "short", month: "short", day: "numeric" }),
    }));
}
