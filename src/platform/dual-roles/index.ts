import { cache } from "react";
import { prisma } from "@/platform/db";
import { getSetting } from "@/platform/settings/service";
import { getActiveTerm } from "@/platform/terms/active-term";
import { permissionDepartmentIds } from "@/platform/rbac/engine";
import { peopleWithPermission } from "@/platform/rbac/permission-holders";
import { renderEmail } from "@/platform/email/templates/renderEmail";
import { notify } from "@/platform/notifications/notify";
import { dualRoleRequestedContext, type PendingDualRoleOffer } from "@/platform/email/templates/volunteers";
import { verifiedLanguagesByPerson, spanishScoresByPerson } from "@/platform/languages";
import { languageLabel } from "@/platform/languages/catalog";
import { firstNameOf } from "@/platform/person-name";
import { addMembership } from "@/platform/memberships/add";
import { recordAudit } from "@/platform/audit";
import { log, errorAttrs } from "@/platform/logging";
import { DUAL_ROLE_DEPARTMENT_CODES } from "./catalog";

/**
 * The catalog and its pure helpers are re-exported so a server caller can reach
 * them from "@/platform/dual-roles". They LIVE in ./catalog because this file
 * imports prisma and notify, and a client component reaching them through here
 * would pull the server graph into the browser bundle. Client components must
 * import ./catalog directly. Same split, and same reason, as platform/languages.
 */
export * from "./catalog";

/** The permission that both opens the queue and scopes it to a department. */
export const DUAL_ROLE_PERMISSION = "volunteers.manage_dual_roles";

/** Where the queue lives, for links in notifications. */
export const DUAL_ROLE_QUEUE_PATH = "/volunteers/dual-roles";

export class DualRoleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DualRoleError";
  }
}

// ---------------------------------------------------------------------------
// Notification
// ---------------------------------------------------------------------------

/**
 * Tell each receiving department's directors that offers are waiting. Call
 * AFTER the transaction that created them has committed.
 *
 * One digest per director per department, not one message per offer: promoting
 * a cycle cohort creates dozens at once, and a message each would bury exactly
 * the people who have to act on them. A director of two dual departments gets
 * one message for each, because the decision and the roster are per department.
 *
 * Best-effort throughout. A delivery failure must never surface as a failed
 * promotion, which has already committed by the time this runs.
 */
export async function notifyDirectorsOfDualRoleOffers(
  offers: Array<{ personId: string; departmentCode: string; primaryDepartmentCode: string }>,
  triggeredById?: string,
): Promise<void> {
  if (offers.length === 0) return;
  try {
    await sendDualRoleDigest(offers, triggeredById);
  } catch (err) {
    log.error(
      "[dual-roles] failed to notify directors of dual-role offers",
      errorAttrs(err, { offerCount: offers.length }),
    );
  }
}

async function sendDualRoleDigest(
  offers: Array<{ personId: string; departmentCode: string; primaryDepartmentCode: string }>,
  triggeredById?: string,
): Promise<void> {
  const codes = [...new Set(offers.flatMap((o) => [o.departmentCode, o.primaryDepartmentCode]))];
  const [holders, baseUrl, people, departments] = await Promise.all([
    peopleWithPermission(DUAL_ROLE_PERMISSION),
    getSetting<string>("app.baseUrl"),
    prisma.person.findMany({
      where: { id: { in: [...new Set(offers.map((o) => o.personId))] } },
      select: { id: true, name: true },
    }),
    prisma.department.findMany({
      where: { code: { in: codes } },
      select: { id: true, code: true, name: true },
    }),
  ]);
  if (holders.length === 0) return;

  const nameById = new Map(people.map((p) => [p.id, p.name]));
  const deptByCode = new Map(departments.map((d) => [d.code, d]));
  const reviewUrl = `${baseUrl}${DUAL_ROLE_QUEUE_PATH}`;

  // Group the offers by the department that has to decide on them.
  const byDepartment = new Map<string, PendingDualRoleOffer[]>();
  for (const offer of offers) {
    const name = nameById.get(offer.personId);
    if (!name) continue;
    const rows = byDepartment.get(offer.departmentCode) ?? [];
    rows.push({
      name,
      primaryDepartment: deptByCode.get(offer.primaryDepartmentCode)?.name ?? offer.primaryDepartmentCode,
    });
    byDepartment.set(offer.departmentCode, rows);
  }

  for (const [departmentCode, rows] of byDepartment) {
    const department = deptByCode.get(departmentCode);
    if (!department) continue;
    rows.sort((a, b) => a.name.localeCompare(b.name));

    // The grant is department-scoped, so the recipients are the holders whose
    // grant actually reaches THIS department -- not everyone who holds the
    // permission. That is what keeps VADM's offers out of INTP's inbox without
    // either department being named in RBAC.
    const recipients = (
      await Promise.all(
        holders.map(async (holder) => {
          const ids = await permissionDepartmentIds(holder.id, DUAL_ROLE_PERMISSION);
          return ids.includes(department.id) ? holder : null;
        }),
      )
    ).filter((h): h is (typeof holders)[number] => h !== null);

    const summary =
      rows.length === 1
        ? `${rows[0].name} offered to also serve with ${department.name}.`
        : `${rows.length} volunteers offered to also serve with ${department.name}.`;

    await Promise.all(
      recipients.map(async (recipient) => {
        const rendered = await renderEmail(
          "volunteers.dual_role_requested",
          dualRoleRequestedContext({
            firstName: firstNameOf(recipient.name) || "there",
            departmentName: department.name,
            offers: rows,
            reviewLink: reviewUrl,
          }),
        );
        await notify(prisma, {
          type: "volunteers.dual_role_requested",
          person: recipient,
          email: { subject: rendered.subject, html: rendered.html },
          teams: {
            title: rows.length === 1 ? `Dual-role offer for ${department.code}` : `Dual-role offers for ${department.code}`,
            summary,
            link: reviewUrl,
          },
          triggeredById,
        });
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Whether this person directs a department that can receive dual-role offers.
 *
 * The Volunteers nav gate. Every director holds the permission, but only the
 * departments that actually ask the dual-role question on the application can
 * ever have a queue, so gating the tab on the permission alone would show it to
 * every director in the clinic and lead nearly all of them to an empty page.
 * A capability like this is what ModuleNavItem.dynamicGate is for.
 *
 * Request-cached, like everything in rbac/engine.ts, because it has two callers
 * on the same render: the app shell resolves every module's gated hrefs
 * (app/(app)/nav-gates.ts) and the volunteers layout resolves this one again for
 * its own sub-nav. `permissionDepartmentIds` was already cached, so only the
 * `department.count` was repeating -- one wasted query on every volunteers page
 * view, for every director who holds the permission.
 */
export const directsADualRoleDepartment = cache(async (personId: string): Promise<boolean> => {
  const departmentIds = await permissionDepartmentIds(personId, DUAL_ROLE_PERMISSION);
  if (departmentIds.length === 0) return false;
  const count = await prisma.department.count({
    where: { id: { in: departmentIds }, code: { in: [...DUAL_ROLE_DEPARTMENT_CODES] } },
  });
  return count > 0;
});

export type DualRoleQueueRow = {
  id: string;
  personId: string;
  personName: string;
  /** Department the offer is TO. */
  departmentCode: string;
  departmentName: string;
  /** Where they already serve this term, by name. Empty if they hold nothing. */
  primaryDepartments: string[];
  status: "PENDING" | "ACCEPTED" | "DECLINED";
  offeredAt: Date;
  decidedAt: Date | null;
  decidedByName: string | null;
  notes: string | null;
  /** Deep link to the application the offer came from. */
  applicationHref: string;
  /**
   * Verified language capabilities, shown on INTP rows only. Read-only context
   * so the director can see "Spanish, 4/5" before deciding rather than opening
   * the language queue in another tab. Never a gate: an unassessed offer is
   * still a real offer, it just tells the director what to do first.
   */
  languages: string[];
  spanishScore: number | null;
};

/**
 * The dual-role queue, scoped to the departments this person actually directs.
 *
 * Two different scopings on purpose. Access is the flat permission check the
 * page does; WHICH rows come back is `permissionDepartmentIds`, because the
 * Director role is KIND-targeted and so resolves to the departments where the
 * person's membership is a directorship. A VADM director asking for the queue
 * gets VADM's offers and nothing else, with neither department named here.
 *
 * Returns [] rather than throwing for someone whose grant reaches no dual
 * department: they can open the page (they hold the permission) and correctly
 * see an empty queue.
 */
export async function listDualRoleQueue(
  actorPersonId: string,
  opts: { includeDecided?: boolean } = {},
): Promise<DualRoleQueueRow[]> {
  const term = await getActiveTerm();
  if (!term) return [];

  const departmentIds = await permissionDepartmentIds(actorPersonId, DUAL_ROLE_PERMISSION);
  if (departmentIds.length === 0) return [];
  const departments = await prisma.department.findMany({
    where: { id: { in: departmentIds }, code: { in: [...DUAL_ROLE_DEPARTMENT_CODES] } },
    select: { id: true, code: true, name: true },
  });
  if (departments.length === 0) return [];
  const visibleCodes = departments.map((d) => d.code);
  const deptByCode = new Map(departments.map((d) => [d.code, d]));

  const interests = await prisma.dualRoleInterest.findMany({
    where: {
      termId: term.id,
      departmentCode: { in: visibleCodes },
      ...(opts.includeDecided ? {} : { status: "PENDING" }),
    },
    select: {
      id: true, personId: true, departmentCode: true, status: true, notes: true,
      createdAt: true, decidedAt: true, applicationId: true,
      person: { select: { name: true } },
      decidedBy: { select: { name: true } },
      application: { select: { cycleId: true } },
    },
    orderBy: [{ status: "asc" }, { createdAt: "asc" }],
  });
  if (interests.length === 0) return [];

  const personIds = [...new Set(interests.map((i) => i.personId))];
  // Where each person already serves. Excludes the offered department itself so
  // an ACCEPTED row does not list the department it was accepted into as though
  // it were the person's home team.
  const [memberships, verified, spanish] = await Promise.all([
    prisma.termMembership.findMany({
      where: { personId: { in: personIds }, termId: term.id, status: "ACTIVE" },
      select: { personId: true, department: { select: { code: true, name: true } } },
    }),
    verifiedLanguagesByPerson(personIds),
    spanishScoresByPerson(personIds),
  ]);
  const membershipsByPerson = new Map<string, Array<{ code: string; name: string }>>();
  for (const m of memberships) {
    membershipsByPerson.set(m.personId, [
      ...(membershipsByPerson.get(m.personId) ?? []),
      m.department,
    ]);
  }

  return interests.map((i) => ({
    id: i.id,
    personId: i.personId,
    personName: i.person.name,
    departmentCode: i.departmentCode,
    departmentName: deptByCode.get(i.departmentCode)?.name ?? i.departmentCode,
    primaryDepartments: (membershipsByPerson.get(i.personId) ?? [])
      .filter((d) => d.code !== i.departmentCode)
      .map((d) => d.name)
      .sort(),
    status: i.status,
    offeredAt: i.createdAt,
    decidedAt: i.decidedAt,
    decidedByName: i.decidedBy?.name ?? null,
    notes: i.notes,
    applicationHref: `/recruitment/cycles/${i.application.cycleId}/applicants/${i.applicationId}`,
    languages: (verified.get(i.personId) ?? []).map(languageLabel),
    spanishScore: spanish.get(i.personId) ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

/**
 * Resolve an interest the actor is actually allowed to decide, in the active
 * term. Shared by both decisions so neither can drift from the other on which
 * rows are reachable.
 */
async function loadDecidableInterest(actorPersonId: string, interestId: string) {
  const term = await getActiveTerm();
  if (!term) throw new DualRoleError("There is no active term.");
  const interest = await prisma.dualRoleInterest.findUnique({
    where: { id: interestId },
    select: { id: true, personId: true, termId: true, departmentCode: true, status: true },
  });
  if (!interest || interest.termId !== term.id) throw new DualRoleError("That dual-role offer no longer exists.");
  if (interest.status !== "PENDING") throw new DualRoleError("That offer has already been decided.");

  const department = await prisma.department.findUnique({
    where: { code: interest.departmentCode },
    select: { id: true, code: true, name: true },
  });
  if (!department) throw new DualRoleError("That department no longer exists.");

  // The same department-scoped check the queue read uses, enforced again on the
  // write. The page filtering rows is a convenience; this is the guard.
  const departmentIds = await permissionDepartmentIds(actorPersonId, DUAL_ROLE_PERMISSION);
  if (!departmentIds.includes(department.id)) {
    throw new DualRoleError("You cannot decide dual-role offers for that department.");
  }
  return { interest, department, term };
}

/**
 * Accept an offer: put the person on the department's roster and record the
 * decision.
 *
 * The membership is created through addMembership rather than a direct write,
 * so this path inherits its guards for free -- above all the offboard
 * convergence one, which stops somebody who has since been offboarded from
 * being quietly put back on a roster by an offer they made months earlier.
 *
 * Always VOLUNTEER: the dual-role question is only asked on the volunteer
 * application, and a dual role is helping out, never a second directorship.
 */
export async function acceptDualRole(
  actorPersonId: string,
  interestId: string,
  notes?: string | null,
): Promise<void> {
  const { interest, department, term } = await loadDecidableInterest(actorPersonId, interestId);

  await addMembership(actorPersonId, {
    personId: interest.personId,
    termId: term.id,
    departmentId: department.id,
    kind: "VOLUNTEER",
  });

  // After the membership, deliberately. If addMembership throws (an offboarded
  // person, a missing foreign key) the offer stays PENDING and the director sees
  // the error and the row again, rather than a row marked accepted for somebody
  // who never reached the roster.
  await prisma.dualRoleInterest.update({
    where: { id: interest.id },
    data: {
      status: "ACCEPTED",
      decidedById: actorPersonId,
      decidedAt: new Date(),
      notes: notes?.trim() || null,
    },
  });

  await recordAudit({
    actorPersonId,
    action: "volunteers.dual_role_accepted",
    entityType: "DualRoleInterest",
    entityId: interest.id,
    after: { personId: interest.personId, departmentCode: department.code },
  });
}

/** Decline an offer. Records who and why; creates no membership. */
export async function declineDualRole(
  actorPersonId: string,
  interestId: string,
  notes?: string | null,
): Promise<void> {
  const { interest, department } = await loadDecidableInterest(actorPersonId, interestId);

  await prisma.dualRoleInterest.update({
    where: { id: interest.id },
    data: {
      status: "DECLINED",
      decidedById: actorPersonId,
      decidedAt: new Date(),
      notes: notes?.trim() || null,
    },
  });

  await recordAudit({
    actorPersonId,
    action: "volunteers.dual_role_declined",
    entityType: "DualRoleInterest",
    entityId: interest.id,
    after: { personId: interest.personId, departmentCode: department.code, notes: notes?.trim() || null },
  });
}
