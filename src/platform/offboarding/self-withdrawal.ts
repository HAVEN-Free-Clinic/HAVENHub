/**
 * Side effects of a member declaring they are not volunteering this term.
 *
 * withdrawFromTerm (my-info) soft-removes their ACTIVE VOLUNTEER memberships and
 * stops. That leaves them half-offboarded: Person.status is still ACTIVE, so Epic
 * access, compliance reminders, and every status-keyed roster still treat them as
 * present, while they have vanished from the department cards on
 * /volunteers/offboarding (those list ACTIVE memberships only). Nobody was told.
 *
 * This module closes both gaps: it puts the member in the offboarding queue and
 * alerts the people who can actually execute an offboard.
 *
 * Lives in platform rather than the volunteers module because eslint forbids
 * src/modules/my-info from importing src/modules/volunteers. It deliberately does
 * not reuse offboarding.flagForOffboarding: that function's actorCanManageTarget
 * scope check is meaningless when the actor is the subject, and would reject a
 * regular volunteer flagging themselves.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { isUniqueConstraintError } from "@/platform/db";
import { getActiveTerm } from "@/platform/terms/active-term";
import { getSetting } from "@/platform/settings/service";
import { peopleWithAnyPermission } from "@/platform/rbac/holders";
import { notify } from "@/platform/notifications/notify";
import { recordAudit } from "@/platform/audit";
import { renderEmail } from "@/platform/email/templates/renderEmail";
import { selfWithdrawalContext } from "@/platform/email/templates/volunteers";
import { log } from "@/platform/logging";

type Db = PrismaClient | Prisma.TransactionClient;

/** Permissions that let a person execute an offboard (see offboarding.executeOffboard). */
const CAN_OFFBOARD = ["volunteers.manage_offboarding", "admin.access"];

/**
 * Build the flag note. The department codes go IN the note because the flagged
 * table's Departments column derives from ACTIVE memberships, which are REMOVED
 * by the time this runs, so it would otherwise render "-" for exactly the rows
 * that need the context most.
 */
export function buildSelfWithdrawalNote(departments: string, reason: string | null): string {
  const base = departments
    ? `Not volunteering this term (${departments})`
    : "Not volunteering this term";
  return reason ? `${base} - "${reason}"` : base;
}

/**
 * Flag the member for offboarding (unless they keep another active role) and
 * notify everyone who can execute an offboard. Returns the number notified.
 *
 * Returns 0 with no writes when there is no ACTIVE term: without one there is no
 * flag to raise and nothing for ops to process.
 */
export async function recordSelfWithdrawal(
  db: Db,
  member: { id: string; name: string },
  detail: { departmentCodes: string[]; reason: string | null },
): Promise<number> {
  const activeTerm = await getActiveTerm();
  if (!activeTerm) return 0;

  // Director guard: executeOffboard strips EVERY membership and sets
  // Person.status to OFFBOARDED, so flagging someone who still holds another role
  // this term (typically a director who also took clinic shifts) puts a one-click
  // path to revoking that role in front of ops. The queue means "should be fully
  // offboarded", and they should not be. They still get the alert, worded as FYI.
  const remaining = await db.termMembership.count({
    where: { personId: member.id, termId: activeTerm.id, status: "ACTIVE" },
  });
  const stillActive = remaining > 0;

  const departments = detail.departmentCodes.join(", ");

  if (!stillActive) {
    await ensureSelfFlag(db, member.id, activeTerm.id, departments, detail.reason);
  }

  const recipients = (await peopleWithAnyPermission(CAN_OFFBOARD)).filter((p) => p.id !== member.id);
  if (recipients.length === 0) {
    log.warn(
      `[offboarding] ${member.name} (${member.id}) declared they are not volunteering this term, but nobody holds volunteers.manage_offboarding to process it.`,
      { personId: member.id },
    );
    return 0;
  }

  const baseUrl = await getSetting<string>("app.baseUrl");
  const reviewLink = `${baseUrl}/volunteers/offboarding`;
  const rendered = await renderEmail(
    "volunteers.self_withdrawal",
    selfWithdrawalContext({
      memberName: member.name,
      departments,
      reason: detail.reason,
      stillActive,
      reviewLink,
    }),
  );

  const summary = stillActive
    ? `${member.name} withdrew from ${departments} but still holds another active role, so they were not added to the offboarding queue.`
    : `${member.name} withdrew from ${departments} and is now flagged in the offboarding queue.`;

  for (const recipient of recipients) {
    await notify(db, {
      type: "volunteers.self_withdrawal",
      person: {
        id: recipient.id,
        entraObjectId: recipient.entraObjectId,
        contactEmail: recipient.contactEmail,
      },
      email: { subject: rendered.subject, html: rendered.html },
      teams: {
        title: `${member.name} is not volunteering this term`,
        summary,
        link: reviewLink,
      },
      triggeredById: member.id,
    });
  }

  return recipients.length;
}

/**
 * Create the member's own OffboardFlag, or leave an existing one alone.
 *
 * Upsert-safe on @@unique([personId, termId]), matching flagForOffboarding: a flag
 * a director already raised keeps its note and its flaggedById, and no second audit
 * row is written. flaggedById is the member themselves, so the flagged table reads
 * "Flagged by: <their own name>".
 */
async function ensureSelfFlag(
  db: Db,
  personId: string,
  termId: string,
  departments: string,
  reason: string | null,
): Promise<void> {
  const existing = await db.offboardFlag.findUnique({
    where: { personId_termId: { personId, termId } },
  });
  if (existing) return;

  const note = buildSelfWithdrawalNote(departments, reason);

  let flagId: string;
  try {
    const flag = await db.offboardFlag.create({
      data: { personId, termId, flaggedById: personId, note },
    });
    flagId = flag.id;
  } catch (err) {
    // Raced with a director flagging them between the read and the write. The
    // winner's row stands, exactly as in flagForOffboarding.
    if (isUniqueConstraintError(err)) return;
    throw err;
  }

  await recordAudit({
    actorPersonId: personId,
    action: "offboard.flag",
    entityType: "OffboardFlag",
    entityId: flagId,
    after: { personId, termId, note, self: true },
  });
}
