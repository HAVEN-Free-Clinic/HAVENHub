/**
 * The wizard's required-field check now lives in the recruitment engine, because
 * the draft-reminder stream has to reach the same verdict from a cron. Re-exported
 * here so the wizard and its test keep their local import.
 */
export { isValuePresent, missingRequiredKeys } from "@/modules/recruitment/engine/required-fields";
