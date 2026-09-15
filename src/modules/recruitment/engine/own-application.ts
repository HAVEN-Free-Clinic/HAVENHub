/**
 * Whether an application is the reviewer's own: a committee member who also
 * applied. Scoring, the roster, the detail page, speed route and the scorer
 * allocator all ask this one question, so they cannot disagree about it.
 *
 * The account link alone is not enough. Applicant.applicantPersonId is set only
 * when the applicant was signed in at submission, so a reviewer who applied
 * signed out carries no link, and a link-only check let them score and read
 * their own application. Unlinked applications are matched the way the email
 * audience matches them (platform/email/audience/resolve.ts): by NetID, or by an
 * address the reviewer is known by.
 */

export type ReviewerIdentity = {
  personId: string;
  /** Lowercased and trimmed, or null. */
  netId: string | null;
  /** Lowercased and trimmed: the contact address and the NetID's Yale address. */
  emails: string[];
};

export type ApplicantIdentity = {
  applicantPersonId: string | null;
  emailLower: string;
  netId: string | null;
};

export function isOwnApplication(applicant: ApplicantIdentity, me: ReviewerIdentity): boolean {
  if (applicant.applicantPersonId === me.personId) return true;
  const netId = applicant.netId?.trim().toLowerCase();
  if (netId && netId === me.netId) return true;
  const email = applicant.emailLower.trim().toLowerCase();
  return email !== "" && me.emails.includes(email);
}

/** Whose application this is among `pool`, for the allocator's "nobody scores
 *  their own" rule: the pool member it matches, else the account link. */
export function applicationOwnerAmong(applicant: ApplicantIdentity, pool: ReviewerIdentity[]): string | null {
  return pool.find((me) => isOwnApplication(applicant, me))?.personId ?? applicant.applicantPersonId;
}
