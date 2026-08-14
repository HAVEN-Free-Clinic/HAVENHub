/**
 * Single-use invite links for a recruitment cycle.
 *
 * The problem they solve: a cycle closes, and someone worth recruiting turns up
 * afterwards. Reopening the cycle admits everyone; this admits exactly one
 * person, leaves a record of who issued the invitation, and expires on its own.
 *
 * TOKEN HANDLING mirrors ApplicantPortalToken and MemberLoginToken: the raw
 * token is returned to the caller once, at creation, and only its SHA-256 hash
 * is stored. Anyone holding the database still cannot use a link.
 *
 * CLAIM TIMING is the design's one genuinely load-bearing decision. The token
 * burns at the invitee's FIRST SIGN-IN, not at submit and not at page load:
 *
 *  - Burning at submit would leave a live, forwardable link circulating for
 *    however long the applicant takes to finish, which for a multi-step wizard
 *    can be days.
 *  - Burning at page load would spend the token on someone who opened the link,
 *    wandered off, and came back -- stranding them mid-application with no way
 *    back in and no way for staff to tell what happened.
 *
 * Claiming stamps `claimedByEmailLower`, and `isInvitedTo` reads THAT rather than
 * the token. So the link is spent the moment it is used, while the person it was
 * spent on keeps access for as long as they need it.
 */

import { createHash, randomBytes } from "node:crypto";
import type { RecruitmentInvite } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";

const DEFAULT_TTL_DAYS = 14;

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Applicant identities are matched case- and whitespace-insensitively everywhere. */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export type CreateInviteOptions = {
  /** Staff-facing note so an outstanding invite is identifiable in the list. */
  label?: string | null;
  /** Days until expiry. Null means never. Defaults to 14. */
  ttlDays?: number | null;
};

/**
 * Issues an invite and returns the RAW token exactly once. Callers must show it
 * to the issuing staffer immediately; it cannot be recovered afterwards.
 */
export async function createInvite(
  actorPersonId: string,
  cycleId: string,
  opts: CreateInviteOptions
): Promise<{ token: string; invite: RecruitmentInvite }> {
  const token = randomBytes(32).toString("base64url");
  const ttlDays = opts.ttlDays === undefined ? DEFAULT_TTL_DAYS : opts.ttlDays;
  const expiresAt =
    ttlDays === null ? null : new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);

  const invite = await prisma.recruitmentInvite.create({
    data: {
      cycleId,
      tokenHash: hashToken(token),
      label: opts.label?.trim() || null,
      expiresAt,
      createdById: actorPersonId,
    },
  });

  await recordAudit({
    action: "recruitment.invite_created",
    actorPersonId,
    entityType: "RecruitmentInvite",
    entityId: invite.id,
    after: { cycleId, label: invite.label, expiresAt },
  });

  return { token, invite };
}

/**
 * Resolves a raw token to its invite and cycle WITHOUT spending it.
 *
 * The claim route needs the cycle before the visitor has signed in, so that it
 * can send them to sign-in and bring them back. Burning the token to answer that
 * question would spend it on anyone who merely opened the link.
 *
 * Returns null for unknown, expired, revoked, and already-claimed tokens alike:
 * a visitor holding a dead link learns only that it is dead.
 */
export async function peekInvite(rawToken: string) {
  return prisma.recruitmentInvite.findFirst({
    where: {
      tokenHash: hashToken(rawToken),
      claimedAt: null,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    include: { cycle: { select: { id: true, publicSlug: true, title: true, status: true } } },
  });
}

/**
 * Spends a raw token on behalf of `email`, returning the claimed invite or null
 * when the token is unknown, already claimed, expired, or revoked.
 *
 * The claim is an atomic updateMany whose WHERE clause carries every condition,
 * so two people racing the same link cannot both be admitted: exactly one
 * updateMany matches a row. This is the same TOCTOU-closing shape verifyMagicToken
 * uses in portal-auth.ts.
 *
 * Re-claiming by the SAME email is a no-op success, so a double-submitted sign-in
 * does not look like a stolen link.
 */
export async function claimInvite(
  rawToken: string,
  email: string
): Promise<RecruitmentInvite | null> {
  const tokenHash = hashToken(rawToken);
  const emailLower = normalizeEmail(email);
  if (!emailLower) return null;

  const claimed = await prisma.recruitmentInvite.updateMany({
    where: {
      tokenHash,
      claimedAt: null,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    data: { claimedAt: new Date(), claimedByEmailLower: emailLower },
  });

  if (claimed.count !== 1) {
    // Either it was never valid, or this same person already claimed it and is
    // signing in again. The second case must not read as a failure.
    const existing = await prisma.recruitmentInvite.findUnique({ where: { tokenHash } });
    if (existing?.claimedByEmailLower === emailLower && !existing.revokedAt) return existing;
    return null;
  }

  return prisma.recruitmentInvite.findUnique({ where: { tokenHash } });
}

/**
 * Whether this applicant identity holds a live invite to this cycle.
 *
 * Reads the CLAIM, not the token, which is what lets an invitee return to an
 * unfinished draft after the link itself is spent. Revoking reaches a claimed
 * invite too, so staff can withdraw an invitation issued in error.
 */
export async function isInvitedTo(cycleId: string, email: string | null | undefined): Promise<boolean> {
  const emailLower = email ? normalizeEmail(email) : "";
  if (!emailLower) return false;

  const invite = await prisma.recruitmentInvite.findFirst({
    where: {
      cycleId,
      claimedByEmailLower: emailLower,
      revokedAt: null,
    },
    select: { id: true },
  });
  return invite !== null;
}

/**
 * Revokes an invite, claimed or not. Kept as a row rather than deleted so the
 * record of who was invited, and by whom, survives the withdrawal.
 */
export async function revokeInvite(actorPersonId: string, inviteId: string): Promise<void> {
  await prisma.recruitmentInvite.updateMany({
    where: { id: inviteId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  await recordAudit({
    action: "recruitment.invite_revoked",
    actorPersonId,
    entityType: "RecruitmentInvite",
    entityId: inviteId,
  });
}

/**
 * The applicant emails that accepted a live invite to this cycle.
 *
 * Feeds the "Invited" marker on the review list. Reviewers working a stack of
 * applications need to know which ones arrived past the deadline by invitation
 * rather than through the open form -- the distinction changes how an
 * application is read, and it is otherwise invisible.
 *
 * Derived from the claim rather than stored on Application: an invited
 * application is exactly one whose applicant accepted a live invite, so a column
 * would be a second copy of that fact, free to drift the moment an invite is
 * withdrawn. Withdrawing correctly un-marks the application here.
 */
export async function invitedEmailsFor(cycleId: string): Promise<Set<string>> {
  const rows = await prisma.recruitmentInvite.findMany({
    where: { cycleId, revokedAt: null, claimedByEmailLower: { not: null } },
    select: { claimedByEmailLower: true },
  });
  return new Set(rows.map((r) => r.claimedByEmailLower!));
}

/** A cycle's invites, newest first, for the management table. */
export async function listInvites(cycleId: string) {
  return prisma.recruitmentInvite.findMany({
    where: { cycleId },
    orderBy: { createdAt: "desc" },
    include: { createdBy: { select: { id: true, name: true } } },
  });
}
