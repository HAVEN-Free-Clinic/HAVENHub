/**
 * Subcommittee membership: who is on which subcommittee, as a lead or a member.
 *
 * Two ways in. Staff add people (one at a time, or by pasting a list of NetIDs
 * and emails, which is how the directors were first imported), and volunteers
 * join on their own while a subcommittee's sign-up is open. A person may be on
 * several subcommittees.
 *
 * Capacity counts MEMBER rows only and binds only self sign-up: leads are
 * appointed, and a staff add is a deliberate override, so neither is refused
 * for a full subcommittee.
 *
 * Permission checks are the caller's job, as in subcommittees.ts, EXCEPT the
 * self-service eligibility rule (joinSubcommittee), which is a policy about
 * who a membership may belong to and so lives here where every caller gets it.
 */
import type { SubcommitteeRole } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { getAccessTerm } from "@/platform/terms/access-term";

export class SubcommitteeSignupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubcommitteeSignupError";
  }
}

export type SubcommitteeMemberRow = {
  id: string;
  personId: string;
  name: string;
  email: string | null;
  netId: string | null;
  role: SubcommitteeRole;
  source: "IMPORT" | "SIGNUP" | "STAFF";
  createdAt: Date;
};

/** Everyone on one subcommittee, leads first, then by name. */
export async function listMembers(subcommitteeId: string): Promise<SubcommitteeMemberRow[]> {
  const rows = await prisma.subcommitteeMembership.findMany({
    where: { subcommitteeId },
    include: { person: { select: { name: true, contactEmail: true, netId: true } } },
  });
  return rows
    .map((r) => ({
      id: r.id,
      personId: r.personId,
      name: r.person.name,
      email: r.person.contactEmail,
      netId: r.person.netId,
      role: r.role,
      source: r.source,
      createdAt: r.createdAt,
    }))
    .sort((a, b) =>
      a.role === b.role ? a.name.localeCompare(b.name) : a.role === "LEAD" ? -1 : 1,
    );
}

export type BulkAddResult = {
  added: string[];
  /** Already on the subcommittee; role updated to the requested one if it differed. */
  updated: string[];
  unchanged: string[];
  notFound: string[];
};

/**
 * Splits a pasted block into identifiers. Newlines, commas, semicolons and
 * whitespace all separate, so a spreadsheet column, an email To: line, or a
 * hand-typed list all work without reformatting.
 */
export function parseIdentifiers(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[\s,;]+/)) {
    const v = part.trim().replace(/^<|>$/g, "");
    const key = v.toLowerCase();
    if (v === "" || seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

/**
 * Adds people by NetID or email, as `role`. Someone already on the
 * subcommittee has their role set to `role` (so re-pasting the director list
 * as LEAD promotes anyone who had signed up as a member).
 *
 * Matching is case-insensitive on NetID and contactEmail. Unmatched entries
 * are returned rather than refused, so one typo in a list of twenty does not
 * block the other nineteen; the page shows them back to fix.
 */
export async function bulkAddMembers(
  actorPersonId: string,
  subcommitteeId: string,
  identifiers: string[],
  role: SubcommitteeRole,
  source: "IMPORT" | "STAFF" = "IMPORT",
): Promise<BulkAddResult> {
  const result: BulkAddResult = { added: [], updated: [], unchanged: [], notFound: [] };
  if (identifiers.length === 0) return result;

  const lowered = identifiers.map((i) => i.toLowerCase());
  const people = await prisma.person.findMany({
    where: {
      OR: [
        { netId: { in: identifiers, mode: "insensitive" } },
        { contactEmail: { in: identifiers, mode: "insensitive" } },
      ],
    },
    select: { id: true, name: true, netId: true, contactEmail: true },
  });
  // Prisma ignores mode: "insensitive" on `in` for Postgres (see
  // audience/resolve.ts), so the query above is a best-effort narrowing and
  // the real match is done here. Fall back to a scan when it found nothing for
  // some identifier, which is what a case mismatch looks like.
  const byKey = new Map<string, (typeof people)[number]>();
  const index = (p: (typeof people)[number]) => {
    if (p.netId) byKey.set(p.netId.toLowerCase(), p);
    if (p.contactEmail) byKey.set(p.contactEmail.toLowerCase(), p);
  };
  people.forEach(index);
  if (lowered.some((k) => !byKey.has(k))) {
    const all = await prisma.person.findMany({
      where: { OR: [{ netId: { not: null } }, { contactEmail: { not: null } }] },
      select: { id: true, name: true, netId: true, contactEmail: true },
    });
    all.forEach(index);
  }

  const existing = await prisma.subcommitteeMembership.findMany({
    where: { subcommitteeId },
    select: { id: true, personId: true, role: true },
  });
  const existingByPerson = new Map(existing.map((m) => [m.personId, m]));
  const handled = new Set<string>();

  for (let i = 0; i < identifiers.length; i++) {
    const person = byKey.get(lowered[i]);
    if (!person) {
      result.notFound.push(identifiers[i]);
      continue;
    }
    if (handled.has(person.id)) continue;
    handled.add(person.id);
    const current = existingByPerson.get(person.id);
    if (!current) {
      await prisma.subcommitteeMembership.create({
        data: { subcommitteeId, personId: person.id, role, source, addedById: actorPersonId },
      });
      result.added.push(person.name);
    } else if (current.role !== role) {
      await prisma.subcommitteeMembership.update({ where: { id: current.id }, data: { role } });
      result.updated.push(person.name);
    } else {
      result.unchanged.push(person.name);
    }
  }

  if (result.added.length + result.updated.length > 0) {
    await recordAudit({
      actorPersonId,
      action: "subcommittee.members_add",
      entityType: "Subcommittee",
      entityId: subcommitteeId,
      after: { role, added: result.added.length, updated: result.updated.length, source },
    });
  }
  return result;
}

export async function setMemberRole(
  actorPersonId: string,
  membershipId: string,
  role: SubcommitteeRole,
): Promise<void> {
  const m = await prisma.subcommitteeMembership.update({ where: { id: membershipId }, data: { role } });
  await recordAudit({
    actorPersonId,
    action: "subcommittee.member_role",
    entityType: "Subcommittee",
    entityId: m.subcommitteeId,
    after: { personId: m.personId, role },
  });
}

export async function removeMember(actorPersonId: string, membershipId: string): Promise<void> {
  const m = await prisma.subcommitteeMembership.findUnique({ where: { id: membershipId } });
  if (!m) return;
  await prisma.subcommitteeMembership.delete({ where: { id: membershipId } });
  await recordAudit({
    actorPersonId,
    action: "subcommittee.member_remove",
    entityType: "Subcommittee",
    entityId: m.subcommitteeId,
    after: { personId: m.personId, role: m.role },
  });
}

/**
 * Whether this person may sign themselves up: active, and on the roster of
 * the term they currently have access to (getAccessTerm, so an incoming
 * volunteer can sign up before the term flips). Alumni and applicants can open
 * the page but not join.
 */
export async function canSelfSignup(personId: string): Promise<boolean> {
  const person = await prisma.person.findUnique({ where: { id: personId }, select: { status: true } });
  if (!person || person.status !== "ACTIVE") return false;
  const term = await getAccessTerm(personId);
  if (!term) return false;
  const membership = await prisma.termMembership.findFirst({
    where: { personId, termId: term.id, status: "ACTIVE" },
    select: { id: true },
  });
  return membership !== null;
}

export type SignupOption = {
  id: string;
  name: string;
  description: string | null;
  signupOpen: boolean;
  capacity: number | null;
  memberCount: number;
  leads: string[];
  myRole: SubcommitteeRole | null;
  /**
   * Everyone on it with their email, but ONLY when the viewer leads it: a lead
   * needs to reach their people, and nobody else needs a list of who joined.
   */
  roster: Array<{ name: string; email: string | null; role: SubcommitteeRole }> | null;
};

/**
 * What the sign-up page shows one person: every active subcommittee that is
 * open for sign-up or that they are already on, with its leads and how full it
 * is. A closed subcommittee they are not on is hidden, since there is nothing
 * they could do with it.
 */
export async function signupOptions(personId: string): Promise<SignupOption[]> {
  const subs = await prisma.subcommittee.findMany({
    where: {
      isActive: true,
      OR: [{ signupOpen: true }, { memberships: { some: { personId } } }],
    },
    include: {
      memberships: {
        select: { personId: true, role: true, person: { select: { name: true, contactEmail: true } } },
      },
    },
    orderBy: [{ order: "asc" }, { name: "asc" }],
  });
  return subs.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    signupOpen: s.signupOpen,
    capacity: s.capacity,
    memberCount: s.memberships.filter((m) => m.role === "MEMBER").length,
    leads: s.memberships
      .filter((m) => m.role === "LEAD")
      .map((m) => m.person.name)
      .sort((a, b) => a.localeCompare(b)),
    myRole: s.memberships.find((m) => m.personId === personId)?.role ?? null,
    roster:
      s.memberships.find((m) => m.personId === personId)?.role === "LEAD"
        ? s.memberships
            .map((m) => ({ name: m.person.name, email: m.person.contactEmail, role: m.role }))
            .sort((a, b) =>
              a.role === b.role ? a.name.localeCompare(b.name) : a.role === "LEAD" ? -1 : 1,
            )
        : null,
  }));
}

/**
 * Self sign-up. The capacity check and the insert run in one transaction that
 * first locks the subcommittee row, so two people taking the last seat at the
 * same moment cannot both get it.
 */
export async function joinSubcommittee(personId: string, subcommitteeId: string): Promise<void> {
  if (!(await canSelfSignup(personId))) {
    throw new SubcommitteeSignupError(
      "Only current volunteers and directors can join a subcommittee.",
    );
  }
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT 1 FROM "Subcommittee" WHERE "id" = ${subcommitteeId} FOR UPDATE`;
    const sub = await tx.subcommittee.findUnique({ where: { id: subcommitteeId } });
    if (!sub || !sub.isActive) throw new SubcommitteeSignupError("That subcommittee is no longer offered.");
    if (!sub.signupOpen) throw new SubcommitteeSignupError(`Sign-up for ${sub.name} is closed.`);
    const already = await tx.subcommitteeMembership.findUnique({
      where: { subcommitteeId_personId: { subcommitteeId, personId } },
    });
    if (already) return;
    if (sub.capacity !== null) {
      const taken = await tx.subcommitteeMembership.count({ where: { subcommitteeId, role: "MEMBER" } });
      if (taken >= sub.capacity) throw new SubcommitteeSignupError(`${sub.name} is full.`);
    }
    await tx.subcommitteeMembership.create({
      data: { subcommitteeId, personId, role: "MEMBER", source: "SIGNUP" },
    });
    await recordAudit(
      {
        actorPersonId: personId,
        action: "subcommittee.join",
        entityType: "Subcommittee",
        entityId: subcommitteeId,
      },
      tx,
    );
  });
}

/**
 * Leaving on your own. Leads cannot: they were appointed, and a lead quietly
 * dropping off would leave a subcommittee leaderless without staff knowing.
 * Allowed while sign-up is closed too, since nobody should be stuck on a
 * subcommittee they can no longer do.
 */
export async function leaveSubcommittee(personId: string, subcommitteeId: string): Promise<void> {
  const m = await prisma.subcommitteeMembership.findUnique({
    where: { subcommitteeId_personId: { subcommitteeId, personId } },
  });
  if (!m) return;
  if (m.role === "LEAD") {
    throw new SubcommitteeSignupError(
      "Leads are appointed by staff. Ask the volunteer coordinators to change your role.",
    );
  }
  await prisma.subcommitteeMembership.delete({ where: { id: m.id } });
  await recordAudit({
    actorPersonId: personId,
    action: "subcommittee.leave",
    entityType: "Subcommittee",
    entityId: subcommitteeId,
  });
}

/** The subcommittees one person is on, for the My Info summary. */
export async function mySubcommittees(
  personId: string,
): Promise<Array<{ id: string; name: string; role: SubcommitteeRole }>> {
  const rows = await prisma.subcommitteeMembership.findMany({
    where: { personId, subcommittee: { isActive: true } },
    select: { role: true, subcommittee: { select: { id: true, name: true, order: true } } },
  });
  return rows
    .sort((a, b) => a.subcommittee.order - b.subcommittee.order || a.subcommittee.name.localeCompare(b.subcommittee.name))
    .map((r) => ({ id: r.subcommittee.id, name: r.subcommittee.name, role: r.role }));
}

/** Whether any active subcommittee is open for sign-up, to decide if My Info should advertise it. */
export async function anySignupOpen(): Promise<boolean> {
  return (await prisma.subcommittee.count({ where: { isActive: true, signupOpen: true } })) > 0;
}
