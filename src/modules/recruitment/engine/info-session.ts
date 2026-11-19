import type { ApplicantType } from "@prisma/client";

/**
 * Info-session attendance as a review signal.
 *
 * Product's rule: an applicant with no info-session check-in is flagged for
 * rejection. It is a flag, never an automatic outcome: nothing here rejects
 * anyone or blocks a submission. A reviewer sees it, can filter on it, and a
 * recruitment lead can reject the flagged cohort in one deliberate step.
 *
 * Only meaningful on a cycle that has INFO_SESSION events. Until the last of
 * them has ended, a missing check-in just means "not yet"; after it, it means
 * they missed every session.
 */

/**
 * Applicant types that are never flagged. Empty today: product said the rule
 * applies to everyone, renewals included. Put "RENEWAL" here to exempt
 * returning members if that changes.
 */
export const INFO_SESSION_EXEMPT_APPLICANT_TYPES: readonly ApplicantType[] = Object.freeze([]);

/** An event with no end time counts as running this long. */
export const INFO_SESSION_DEFAULT_LENGTH_MS = 60 * 60 * 1000;

/** NONE: the cycle has no info sessions, so there is nothing to flag. */
export type InfoSessionPhase = "NONE" | "UPCOMING" | "ENDED";

export type InfoSessionStatus = "ATTENDED" | "NOT_YET" | "FLAGGED" | "EXEMPT";

/** When an event is over: its end time, or an hour after it starts. */
export function infoSessionEndsAt(event: { startsAt: Date; endsAt: Date | null }): Date {
  return event.endsAt ?? new Date(event.startsAt.getTime() + INFO_SESSION_DEFAULT_LENGTH_MS);
}

/** Where the cycle's info sessions stand, judged by the last one to end. */
export function infoSessionPhase(
  events: { startsAt: Date; endsAt: Date | null }[],
  now: Date,
): { phase: InfoSessionPhase; lastEndsAt: Date | null } {
  if (events.length === 0) return { phase: "NONE", lastEndsAt: null };
  const lastEndsAt = new Date(Math.max(...events.map((e) => infoSessionEndsAt(e).getTime())));
  return { phase: now.getTime() >= lastEndsAt.getTime() ? "ENDED" : "UPCOMING", lastEndsAt };
}

/** Who checked in to any of the cycle's info sessions, in both currencies an
 *  EventAttendance row can carry: a linked Person, or a walk-up's lowercased
 *  email (plus the linked person's own address, so a row linked after the fact
 *  still matches an applicant who has no Person link of their own). */
export type InfoSessionAttendance = {
  personIds: ReadonlySet<string>;
  emails: ReadonlySet<string>;
  /** Lowercased NetIDs of checked-in people. A member checked in by name is
   *  stored under their Person, whose contactEmail is usually the alias form
   *  (first.last@yale.edu), while their application may carry the NetID form
   *  and no account link. Without this they read as absent and get flagged. */
  netIds?: ReadonlySet<string>;
};

export function attendedInfoSession(
  applicant: { applicantPersonId: string | null; emailLower: string },
  attendance: InfoSessionAttendance,
): boolean {
  if (applicant.applicantPersonId && attendance.personIds.has(applicant.applicantPersonId)) return true;
  const email = applicant.emailLower.toLowerCase();
  if (attendance.emails.has(email)) return true;
  const netIds = attendance.netIds;
  if (!netIds || netIds.size === 0) return false;
  // Only VERIFIED identifiers match: the account link and the application email
  // (proven by SSO or a magic link). Applicant.netId is not used, because an
  // applicant signed in with a non-Yale address can type any NetID there and
  // clear their own flag. A NetID-form address ("ab123@yale.edu") IS verified,
  // so it may stand in for that NetID.
  const m = /^([a-z0-9]+)@yale\.edu$/.exec(email);
  return m !== null && netIds.has(m[1]);
}

/** One application's status, or null on a cycle with no info sessions. */
export function infoSessionStatus(input: {
  phase: InfoSessionPhase;
  attended: boolean;
  applicantType: ApplicantType;
}): InfoSessionStatus | null {
  if (input.phase === "NONE") return null;
  if (input.attended) return "ATTENDED";
  if (INFO_SESSION_EXEMPT_APPLICANT_TYPES.includes(input.applicantType)) return "EXEMPT";
  return input.phase === "ENDED" ? "FLAGGED" : "NOT_YET";
}

/** How each status reads on a badge. Attended and exempt rows get no badge:
 *  the flag is the signal, and a column of green ticks would bury it. */
export const INFO_SESSION_BADGE: Record<InfoSessionStatus, { label: string; tone: "default" | "critical" } | null> = {
  ATTENDED: null,
  EXEMPT: null,
  NOT_YET: { label: "No info session yet", tone: "default" },
  FLAGGED: { label: "No info session attended: flagged for rejection", tone: "critical" },
};
