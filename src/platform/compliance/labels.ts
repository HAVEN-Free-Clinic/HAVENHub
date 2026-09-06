/**
 * The one place a compliance status or an onboarding task state is turned into
 * words and a tone.
 *
 * Before this module there were three vocabularies for `ComplianceStatus` and
 * four renderings of `OnboardingTaskState`, so a member and their director read
 * different words for the same row: the member saw "Awaiting verification" on
 * /my-info and emailed a director who was looking at "Needs verification" on
 * /volunteers. Two of the director-side maps were byte-identical copies, one of
 * them under a comment claiming they were shared.
 *
 * ## Why audience is a parameter and not a single label
 *
 * The wording legitimately differs by who is reading, and the codebase had
 * already worked that out in two places worth preserving:
 *
 *  - A member is being told what to do next, so a gap reads as a next step
 *    ("Action needed"), not a verdict ("Incomplete"). Telling a director
 *    "Action needed" would be wrong: it is not their action.
 *  - A member who genuinely cannot act on a task (no CTA anywhere, e.g. EHS is
 *    recorded by a coordinator) gets a neutral "Pending" instead, because
 *    "Action needed" would send them looking for a button that does not exist.
 *
 * Audience is the reader, NOT the subject. /volunteers/compliance/[personId]
 * shows one member's clearance to a compliance manager, so it asks for "staff"
 * and matches the roster the manager clicked in from.
 *
 * Tone is the Badge tone, so callers pass it straight through.
 */

import type { ComplianceStatus } from "./rules";
import type { OnboardingTaskState } from "./task-state";

/** Who is reading the label, which is not always who the row is about. */
export type LabelAudience = "member" | "staff";

/** Badge tones used for status display. */
export type StatusTone = "default" | "success" | "warning" | "critical";

export type StatusLabel = { label: string; tone: StatusTone };

const COMPLIANCE_STAFF: Record<ComplianceStatus, StatusLabel> = {
  COMPLIANT: { label: "Compliant", tone: "success" },
  EXPIRING_SOON: { label: "Expiring soon", tone: "warning" },
  EXPIRED: { label: "Expired", tone: "critical" },
  PENDING_VERIFICATION: { label: "Needs verification", tone: "warning" },
  UNKNOWN_DATE: { label: "Date unknown", tone: "default" },
  NO_CERTIFICATE: { label: "No certificate", tone: "default" },
};

const COMPLIANCE_MEMBER: Record<ComplianceStatus, StatusLabel> = {
  COMPLIANT: { label: "Valid", tone: "success" },
  EXPIRING_SOON: { label: "Expiring soon", tone: "warning" },
  EXPIRED: { label: "Expired", tone: "critical" },
  // Warning rather than the staff neutral: for the member this is the one cert
  // state they can resolve by supplying a date, so it is not a quiet row.
  UNKNOWN_DATE: { label: "Needs completion date", tone: "warning" },
  PENDING_VERIFICATION: { label: "Awaiting verification", tone: "warning" },
  NO_CERTIFICATE: { label: "Not uploaded", tone: "default" },
};

/**
 * Canonical display order for the status vocabulary: summary tiles, the status
 * filter and the loading skeleton all read it, so a tile cannot end up in a
 * different position from the option that filters to it. This is DISPLAY order;
 * roster row sorting is a separate concern (STATUS_ORDER in the volunteers
 * compliance service, which puts non-compliant first).
 */
export const ALL_COMPLIANCE_STATUSES: ComplianceStatus[] = [
  "COMPLIANT",
  "EXPIRING_SOON",
  "EXPIRED",
  "PENDING_VERIFICATION",
  "UNKNOWN_DATE",
  "NO_CERTIFICATE",
];

/**
 * Words and tone for a HIPAA compliance status.
 *
 * Staff labels are the roster's vocabulary; member labels describe the member's
 * own certificate from their side ("Valid", "Not uploaded").
 */
export function complianceStatusLabel(
  status: ComplianceStatus,
  audience: LabelAudience,
): StatusLabel {
  return audience === "member" ? COMPLIANCE_MEMBER[status] : COMPLIANCE_STAFF[status];
}

const TASK_STAFF: Record<OnboardingTaskState, StatusLabel> = {
  COMPLETE: { label: "Complete", tone: "success" },
  IN_PROGRESS: { label: "In progress", tone: "warning" },
  INCOMPLETE: { label: "Incomplete", tone: "critical" },
  NOT_REQUIRED: { label: "Not required", tone: "default" },
};

const TASK_MEMBER: Record<OnboardingTaskState, StatusLabel> = {
  COMPLETE: { label: "Complete", tone: "success" },
  IN_PROGRESS: { label: "In progress", tone: "warning" },
  // Overridden to "Pending" below when the member has nothing to act on.
  INCOMPLETE: { label: "Action needed", tone: "warning" },
  NOT_REQUIRED: { label: "Not required", tone: "default" },
};

/** An outstanding task the member cannot act on themselves. */
const TASK_MEMBER_PENDING: StatusLabel = { label: "Pending", tone: "default" };

/**
 * Words and tone for an onboarding task state.
 *
 * `actionable` applies to the member audience only, and only to an outstanding
 * task: pass false when the row offers no route to resolve it (no internal
 * link, no external one), so it reads as "Pending" rather than sending the
 * member hunting for a control that is not there. Defaults to true, which is
 * the common case: nearly every task row links somewhere.
 */
export function onboardingTaskLabel(
  state: OnboardingTaskState,
  opts: { audience: LabelAudience; actionable?: boolean },
): StatusLabel {
  if (opts.audience !== "member") return TASK_STAFF[state];
  if (state === "INCOMPLETE" && opts.actionable === false) return TASK_MEMBER_PENDING;
  return TASK_MEMBER[state];
}
