import { applicationAvailabilityDates } from "@/platform/recruitment/incoming-roster";
import { clinicDateOptions } from "../templates/clinic-dates";

/**
 * The clinic dates an applicant chose on their application, labelled exactly as
 * the application's availability picker labelled them, for the onboarding
 * contract's availability check.
 *
 * Parsed through the same platform helper promotion and the schedule builder
 * read, so the dates a volunteer is shown here are the dates that become their
 * baseline availability and the dates a director drafts against.
 */
export function applicationAvailabilityLabels(answers: unknown, clinicDates: Date[]): string[] {
  return clinicDateOptions(applicationAvailabilityDates(answers, clinicDates)).map((o) => o.label);
}
