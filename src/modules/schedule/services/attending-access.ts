/**
 * Turning an attending into someone who can sign in.
 *
 * The bridge is one nullable column, Attending.personId. The roster stays the
 * source of truth for who covers clinic; the Person exists only so they have an
 * identity to authenticate as, a theme preference, and an inbox. Nothing clinical
 * moves onto it.
 *
 * NO NEW AUTH CODE IS NEEDED, which is why this file is as small as it is:
 *   - a Yale address (@yale.edu) matches at sign-in through match-person's
 *     contactEmail step, which trusts only Yale-asserted claims. YSM faculty
 *     therefore just sign in.
 *   - any other address goes through the member magic link, which is already
 *     built and already refuses Yale addresses (they must use SSO).
 * So enabling access is: make the Person, grant the role, tell them.
 *
 * WHY contactEmail AND NOT netId: Person.netId is the Yale NetID, is shaped like
 * one (see isNetIdShaped), and feeds the YNHH Epic access PDF. Putting an address
 * there produces a value that can never match a sign-in and corrupts a downstream
 * document. The roster's `email` is an address; it belongs in contactEmail.
 */

import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { can } from "@/platform/rbac/engine";
import { getSetting } from "@/platform/settings/service";
import { queueEmail } from "@/platform/email/send";
import { renderEmail } from "@/platform/email/templates/renderEmail";
import { log, errorAttrs } from "@/platform/logging";
import { AttendingForbiddenError, AttendingValidationError } from "./attendings";

/** The system role enableHubAccess grants. Must match SYSTEM_ROLES. */
const ATTENDING_ROLE_NAME = "Attending";

const YALE_DOMAIN = "@yale.edu";

/** What the roster row shows about this attending's Hub access. */
export type HubAccessState = {
  attendingId: string;
  personId: string | null;
  /** The address the account is (or would be) reachable at. */
  email: string | null;
  /** How they sign in, given that address. Null when there is no address. */
  signInMethod: "yale-sso" | "email-link" | null;
  /** Why access cannot be enabled, or null when it can. */
  blockedReason: string | null;
};

/**
 * Whether one attending can be given Hub access, and how they would sign in.
 *
 * Computed rather than stored: the roster's email is edited freely by Faculty
 * Relations (and rewritten wholesale by the contact-sheet importer), so a stored
 * "can sign in" flag would go stale the moment an address changed.
 */
export function hubAccessState(a: {
  id: string;
  email: string | null;
  isActive: boolean;
  personId: string | null;
}): HubAccessState {
  const email = a.email?.trim().toLowerCase() || null;
  const signInMethod = email ? (email.endsWith(YALE_DOMAIN) ? "yale-sso" : "email-link") : null;
  let blockedReason: string | null = null;
  if (!a.personId) {
    if (!email) blockedReason = "No email address on file.";
    else if (!a.isActive) blockedReason = "This attending is inactive.";
  }
  return { attendingId: a.id, personId: a.personId, email, signInMethod, blockedReason };
}

export type EnableResult =
  | { outcome: "enabled"; personId: string; linkedExisting: boolean }
  | { outcome: "already-enabled"; personId: string }
  | { outcome: "skipped"; reason: string };

/**
 * Give one attending a Hub login: find or create their Person, link it, grant the
 * Attending role, and email them.
 *
 * Idempotent. Re-running for an already-linked attending re-asserts the role
 * grant (so a manually revoked one heals) and sends nothing.
 *
 * LINKS an existing Person rather than creating a second one when the address is
 * already known. That case is real and not rare: an attending who once volunteered,
 * a PA who is also staff, a faculty member who directs a department. Creating a
 * duplicate would split their identity in half -- two rows, one of which holds
 * their history and the other their attending schedule -- and Person.contactEmail
 * is unique anyway, so the create would simply fail.
 */
export async function enableHubAccess(
  actorPersonId: string,
  attendingId: string,
  opts: { notify?: boolean } = {},
): Promise<EnableResult> {
  if (!(await can(actorPersonId, "schedule.manage_attendings"))) throw new AttendingForbiddenError();

  const attending = await prisma.attending.findUnique({
    where: { id: attendingId },
    select: { id: true, fullName: true, scheduleName: true, email: true, isActive: true, personId: true },
  });
  if (!attending) throw new AttendingValidationError("Attending not found.");

  if (attending.personId) {
    await grantAttendingRole(attending.personId);
    return { outcome: "already-enabled", personId: attending.personId };
  }

  const state = hubAccessState(attending);
  if (state.blockedReason) return { outcome: "skipped", reason: state.blockedReason };

  const email = state.email!;

  // Case-insensitive, because contactEmail is stored as typed while the unique
  // index is not case-folded: "P.Bia@yale.edu" and "p.bia@yale.edu" are the same
  // mailbox and must resolve to the same Person, or the create below races the
  // index and 500s on a duplicate that a lookup would have found.
  const existingPerson = await prisma.person.findFirst({
    where: { contactEmail: { equals: email, mode: "insensitive" } },
    select: { id: true, status: true, attendingProfile: { select: { id: true, scheduleName: true } } },
  });

  if (existingPerson && existingPerson.status !== "ACTIVE") {
    // An OFFBOARDED Person cannot sign in (getActivePerson gates on status), so
    // linking one would hand out access that silently does not work. Say so
    // instead of producing a roster row that claims access it does not have.
    return {
      outcome: "skipped",
      reason: "A Hub account exists for that address but is not active. Reactivate it in Admin first.",
    };
  }

  // Two roster rows carrying ONE address -- a shared practice inbox, or the same
  // doctor entered twice under different schedule names. Attending.personId is
  // unique, so linking the second would throw a raw P2002 from the update below
  // and, in the bulk run, read as an unexplained failure. Refuse with the name
  // that already holds it, which is also the diagnosis: it is nearly always a
  // duplicate roster row Faculty Relations should merge.
  if (existingPerson?.attendingProfile && existingPerson.attendingProfile.id !== attending.id) {
    return {
      outcome: "skipped",
      reason: `That address already signs in as "${existingPerson.attendingProfile.scheduleName}". Give this attending their own address, or merge the duplicate roster row.`,
    };
  }

  let personId: string;
  const linkedExisting = !!existingPerson;

  if (existingPerson) {
    personId = existingPerson.id;
  } else {
    // fullName ("Bia, Margaret") is the roster's formal form and scheduleName
    // ("Peggy Bia") is how the clinic writes them. Person.name is shown in the
    // toolbar and on every page they touch, so it takes the name the clinic
    // actually uses.
    const created = await prisma.person.create({
      data: {
        name: attending.scheduleName,
        contactEmail: email,
        status: "ACTIVE",
        // netId deliberately left null. See the file header.
      },
      select: { id: true },
    });
    personId = created.id;
  }

  await prisma.attending.update({ where: { id: attending.id }, data: { personId } });
  await grantAttendingRole(personId);

  await recordAudit({
    actorPersonId,
    action: "schedule.attending_access_enable",
    entityType: "Attending",
    entityId: attending.id,
    after: { personId, email, linkedExisting },
  });

  if (opts.notify !== false) {
    await sendWelcome(attending.scheduleName, email, state.signInMethod, personId, actorPersonId);
  }

  return { outcome: "enabled", personId, linkedExisting };
}

/**
 * Revoke one attending's Hub access: unlink the Person and drop the role.
 *
 * The Person row itself SURVIVES. It may carry membership history, incident
 * reports, or support tickets that predate their attending record, and deleting
 * it would take those with it. Unlinked plus ungranted is the whole revocation:
 * with no Attending row behind them they see no attending schedule, and with no
 * schedule.view they do not reach the module.
 *
 * Only the role this feature grants is removed. A person who is separately a
 * director keeps their own roles and their own access, which is the point of
 * removing one assignment rather than clearing the person's grants.
 */
export async function disableHubAccess(actorPersonId: string, attendingId: string): Promise<void> {
  if (!(await can(actorPersonId, "schedule.manage_attendings"))) throw new AttendingForbiddenError();

  const attending = await prisma.attending.findUnique({
    where: { id: attendingId },
    select: { id: true, personId: true },
  });
  if (!attending) throw new AttendingValidationError("Attending not found.");
  if (!attending.personId) return;

  const personId = attending.personId;
  const role = await prisma.role.findUnique({ where: { name: ATTENDING_ROLE_NAME }, select: { id: true } });

  await prisma.$transaction(async (tx) => {
    await tx.attending.update({ where: { id: attending.id }, data: { personId: null } });
    if (role) {
      await tx.roleAssignment.deleteMany({ where: { roleId: role.id, personId } });
    }
  });

  await recordAudit({
    actorPersonId,
    action: "schedule.attending_access_disable",
    entityType: "Attending",
    entityId: attending.id,
    before: { personId },
  });
}

export type BulkEnableResult = {
  enabled: number;
  linkedExisting: number;
  alreadyEnabled: number;
  /** Roster rows that could not be given access, with the reason. */
  skipped: Array<{ scheduleName: string; reason: string }>;
};

/**
 * Give every ACTIVE attending with an email on file a Hub login.
 *
 * The rollout path: Faculty Relations runs this once and the roster is online.
 * Idempotent, so it is also the maintenance path -- re-run it after a contact
 * sheet import and only the newcomers are touched.
 *
 * Sequential, not Promise.all: each iteration does a find-or-create against a
 * uniquely-indexed column and then queues an email, and running the roster
 * concurrently would turn two attendings sharing a shared-practice address into a
 * unique-violation race. A roster is a few hundred rows at most.
 */
export async function enableHubAccessForActiveRoster(
  actorPersonId: string,
  opts: { notify?: boolean } = {},
): Promise<BulkEnableResult> {
  if (!(await can(actorPersonId, "schedule.manage_attendings"))) throw new AttendingForbiddenError();

  const roster = await prisma.attending.findMany({
    where: { isActive: true },
    select: { id: true, scheduleName: true },
    orderBy: { scheduleName: "asc" },
  });

  const result: BulkEnableResult = { enabled: 0, linkedExisting: 0, alreadyEnabled: 0, skipped: [] };

  for (const a of roster) {
    try {
      const r = await enableHubAccess(actorPersonId, a.id, opts);
      if (r.outcome === "enabled") {
        result.enabled += 1;
        if (r.linkedExisting) result.linkedExisting += 1;
      } else if (r.outcome === "already-enabled") {
        result.alreadyEnabled += 1;
      } else {
        result.skipped.push({ scheduleName: a.scheduleName, reason: r.reason });
      }
    } catch (err) {
      // One bad roster row must not abort the rollout. Report it as skipped and
      // keep going: the alternative is a half-enabled roster with no record of
      // where it stopped.
      log.error("[attending-access] enable failed", { attendingId: a.id, ...errorAttrs(err) });
      result.skipped.push({
        scheduleName: a.scheduleName,
        reason: err instanceof AttendingValidationError ? err.message : "Unexpected error.",
      });
    }
  }

  await recordAudit({
    actorPersonId,
    action: "schedule.attending_access_bulk_enable",
    entityType: "Attending",
    after: {
      enabled: result.enabled,
      linkedExisting: result.linkedExisting,
      alreadyEnabled: result.alreadyEnabled,
      skipped: result.skipped.length,
    },
  });

  return result;
}

/** Idempotently assign the Attending role to this person. */
async function grantAttendingRole(personId: string): Promise<void> {
  const role = await prisma.role.findUnique({ where: { name: ATTENDING_ROLE_NAME }, select: { id: true } });
  if (!role) {
    // The role ships as a migration, so its absence is a deploy problem, not a
    // per-attending one. Log rather than throw: the link is still worth making,
    // and re-running enableHubAccess once the role exists heals the grant.
    log.error("[attending-access] Attending role missing; access granted no permissions", { personId });
    return;
  }
  const existing = await prisma.roleAssignment.findFirst({
    where: { roleId: role.id, personId, departmentId: null, kind: null, termId: null },
    select: { id: true },
  });
  if (existing) return;
  // Global (termId null), because an attending's Hub access is not a term
  // membership and should not lapse at a term rollover the way a volunteer's
  // does. Faculty Relations revokes it explicitly when someone leaves.
  await prisma.roleAssignment.create({ data: { roleId: role.id, personId } });
}

async function sendWelcome(
  attendingName: string,
  email: string,
  signInMethod: "yale-sso" | "email-link" | null,
  personId: string,
  actorPersonId: string,
): Promise<void> {
  try {
    const baseUrl = (await getSetting<string>("app.baseUrl")).replace(/\/+$/, "");
    const signInHint =
      signInMethod === "yale-sso"
        ? "Sign in with your Yale account -- the same NetID and password you use for Yale email. There is no separate password to set up."
        : `Go to the sign-in page, enter this address (${email}), and we will email you a sign-in link. There is no password to remember.`;
    const { subject, html } = await renderEmail("attending-hub-access", {
      scheduleUrl: `${baseUrl}/schedule`,
      loginUrl: `${baseUrl}/login`,
      attendingName,
      signInHint,
    });
    await queueEmail(prisma, {
      to: email,
      subject,
      html,
      template: "attending-hub-access",
      personId,
      triggeredById: actorPersonId,
    });
  } catch (err) {
    // Best-effort: access is already granted, and a failed welcome must not undo
    // it. Logged rather than swallowed so a systematically broken send is visible.
    log.error("[attending-access] welcome email failed", { personId, ...errorAttrs(err) });
  }
}
