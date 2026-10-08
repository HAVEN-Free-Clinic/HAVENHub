/**
 * Provisional EHS clearance: a time-limited stand-in for a completion that is
 * genuinely on its way (a TB test taken but not resulted, a mask fit booked).
 * See EhsProvisionalClearance in the schema for how reads treat it.
 *
 * Unlike markEhsComplete, these check permission themselves. A grant opens
 * clinical access, so the rule lives with the write and cannot be skipped by a
 * page that forgets to gate it. The permission is granted by no role, so only
 * Platform Admin (the "*" wildcard) holds it.
 */

import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { can } from "@/platform/rbac/engine";
import { DEFAULT_TIME_ZONE } from "@/platform/dates/zone";

export const PROVISIONAL_PERMISSION = "volunteers.grant_provisional_ehs";
export const MAX_PROVISIONAL_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export class ProvisionalForbiddenError extends Error {
  constructor() {
    super("Only Platform Admins can grant or revoke provisional EHS clearance.");
    this.name = "ProvisionalForbiddenError";
  }
}

export class ProvisionalInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProvisionalInvalidError";
  }
}

export async function grantProvisionalClearance(
  actorId: string,
  input: { personId: string; trainingId: string; expiresAt: Date; reason: string },
  now: Date = new Date(),
) {
  if (!(await can(actorId, PROVISIONAL_PERMISSION))) throw new ProvisionalForbiddenError();

  const reason = input.reason.trim();
  if (!reason) throw new ProvisionalInvalidError("Give a reason for the provisional clearance.");
  if (input.expiresAt.getTime() <= now.getTime()) {
    throw new ProvisionalInvalidError("The end date must be in the future.");
  }
  if (input.expiresAt.getTime() > now.getTime() + (MAX_PROVISIONAL_DAYS + 1) * DAY_MS) {
    throw new ProvisionalInvalidError(
      `Provisional clearance can last at most ${MAX_PROVISIONAL_DAYS} days.`,
    );
  }

  // Nothing to stand in for once the real completion is on file.
  const done = await prisma.ehsCompletion.findUnique({
    where: { personId_trainingId: { personId: input.personId, trainingId: input.trainingId } },
    select: { id: true },
  });
  if (done) throw new ProvisionalInvalidError("This item is already complete.");

  // One live grant per person and item: a new grant replaces the old one, so
  // the end date on screen is always the one that counts.
  const { grant, superseded } = await prisma.$transaction(async (tx) => {
    const old = await tx.ehsProvisionalClearance.updateMany({
      where: {
        personId: input.personId,
        trainingId: input.trainingId,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      data: { revokedAt: now, revokedById: actorId },
    });
    const created = await tx.ehsProvisionalClearance.create({
      data: {
        personId: input.personId,
        trainingId: input.trainingId,
        expiresAt: input.expiresAt,
        reason,
        grantedById: actorId,
      },
    });
    return { grant: created, superseded: old.count };
  });

  await recordAudit({
    actorPersonId: actorId,
    action: "ehs.provisional_grant",
    entityType: "EhsProvisionalClearance",
    entityId: grant.id,
    after: {
      personId: input.personId,
      trainingId: input.trainingId,
      expiresAt: input.expiresAt,
      reason,
      superseded,
    },
  });
  return grant;
}

export async function revokeProvisionalClearance(
  actorId: string,
  grantId: string,
  now: Date = new Date(),
): Promise<void> {
  if (!(await can(actorId, PROVISIONAL_PERMISSION))) throw new ProvisionalForbiddenError();

  const existing = await prisma.ehsProvisionalClearance.findUnique({
    where: { id: grantId },
    select: { personId: true, trainingId: true, expiresAt: true, revokedAt: true },
  });
  if (!existing || existing.revokedAt || existing.expiresAt.getTime() <= now.getTime()) {
    throw new ProvisionalInvalidError("This provisional clearance is not active.");
  }

  await prisma.ehsProvisionalClearance.update({
    where: { id: grantId },
    data: { revokedAt: now, revokedById: actorId },
  });
  await recordAudit({
    actorPersonId: actorId,
    action: "ehs.provisional_revoke",
    entityType: "EhsProvisionalClearance",
    entityId: grantId,
    before: {
      personId: existing.personId,
      trainingId: existing.trainingId,
      expiresAt: existing.expiresAt,
    },
  });
}

/**
 * 23:59:59 on `ymd` (YYYY-MM-DD) in the clinic's time zone, so a grant "until
 * Oct 14" lasts through the evening of Oct 14 in New Haven rather than ending at
 * midnight UTC the night before. Tries both Eastern offsets and keeps the one
 * that lands on that date at 23:00 local, which handles daylight saving.
 */
export function endOfClinicDay(ymd: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) throw new ProvisionalInvalidError("Pick an end date.");
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: DEFAULT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  });
  for (const offset of ["-04:00", "-05:00"]) {
    const candidate = new Date(`${ymd}T23:59:59${offset}`);
    const parts = Object.fromEntries(fmt.formatToParts(candidate).map((p) => [p.type, p.value]));
    if (`${parts.year}-${parts.month}-${parts.day}` === ymd && parts.hour === "23") return candidate;
  }
  return new Date(`${ymd}T23:59:59-05:00`);
}

/** Ends whichever grant is live for this person and item, from the profile page. */
export async function revokeLiveProvisional(
  actorId: string,
  personId: string,
  trainingId: string,
  now: Date = new Date(),
): Promise<void> {
  const live = await prisma.ehsProvisionalClearance.findFirst({
    where: { personId, trainingId, revokedAt: null, expiresAt: { gt: now } },
    select: { id: true },
  });
  if (!live) throw new ProvisionalInvalidError("This provisional clearance is not active.");
  await revokeProvisionalClearance(actorId, live.id, now);
}