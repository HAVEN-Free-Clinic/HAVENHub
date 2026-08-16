import { z } from "zod";
import { prisma } from "@/platform/db";
import { getActiveTerm } from "@/platform/terms/active-term";
import { can, hasPlatformScope, permissionDepartmentIds } from "@/platform/rbac/engine";
import type { McpTool } from "./index";

/**
 * Phase 3: the first Fin tools that answer questions about someone OTHER than
 * the caller. Everything about their authorization follows from that one fact.
 *
 * Both tools below key their entire authorization on
 * permissionDepartmentIds(callerId, "volunteers.view", termId), never on
 * can()/getEffectivePermissions(). can() only answers "does this permission
 * reach them ANYWHERE", which is the wrong question for a department-scoped
 * read: the baseline Director role grants volunteers.view through a
 * kind-targeted RoleAssignment (see system-roles.ts), so a caller who directs
 * Nursing and merely volunteers in Triage has can(caller, "volunteers.view")
 * === true, and a tool gated on that boolean alone would hand them Triage's
 * roster too. permissionDepartmentIds instead keeps each assignment's own
 * scope intact, so that same kind-targeted grant resolves to Nursing only --
 * see its doc comment in src/platform/rbac/engine.ts, and the
 * "directs A, volunteers in B" test in roster.test.ts, which is what actually
 * proves this file does not regress into the can()-shaped bug.
 *
 * Contact info (email/phone) is a second, separate axis. No director-facing
 * page in the Hub shows a fellow member's contactEmail or phone -- only
 * /admin/people, gated on admin.manage_people, does (see person-form.tsx and
 * people-table.tsx). memberStatusTool checks that exact permission before
 * appending a contact line, and only as an addition to an answer the
 * departmental check already authorized -- it is never a substitute for that
 * check, so an admin.manage_people holder with no departmental standing of
 * their own still gets the plain refusal below, same as anyone else. This is
 * a deliberate scope decision: extending admin.manage_people into a
 * department-blind "see anyone" master key (the way volunteers.manage_compliance
 * is one for HIPAA certificates, see platform/compliance/access.ts) would add a
 * second authorization path to reason about and test, which is exactly the
 * kind of extra surface a first cut of a "reads about other people" tool
 * should not carry. departmentRosterTool never appends contact info at all,
 * even for an admin.manage_people caller: a roster question is "who", not
 * "how do I reach them", and a whole department's emails in one list answer
 * is a bulk PII dump that a single-person lookup is not.
 *
 * Neither tool renders a date, so the clinicDate/formatCalendarDate (UTC)
 * concern that applies elsewhere in this MCP surface does not apply here.
 *
 * A second authorization path, added alongside permissionDepartmentIds: a
 * caller whose volunteers.view reaches them through a personId-targeted
 * RoleAssignment (hasPlatformScope, see its doc comment in engine.ts) gets
 * clinic-wide reach instead of being scoped to their own memberships. This
 * closes two real gaps -- a platform admin (e.g. IT) with no clinical
 * department membership got refused a roster the Hub itself shows them
 * freely at /admin/people, and a clinic-wide role holder (e.g. Compliance
 * Manager) got capped at "their own department" like a plain director. It is
 * checked FIRST and ONLY widens when true; a caller who does not clear it
 * falls through to permissionDepartmentIds exactly as before. It must never
 * be satisfied by a department- or kind-targeted assignment -- that would
 * turn every director's scoped grant into clinic-wide reach, the exact leak
 * permissionDepartmentIds exists to prevent (see the "directs A, volunteers
 * in B" test below, which is unaffected by this addition on purpose).
 */

/**
 * Chat output has to stay a short answer, not a data dump -- Intercom has no
 * pagination, and a 200-name roster pasted into a member's chat is not
 * usable. Cuts the list at MAX_LISTED and folds the remainder into a count
 * instead of silently dropping it, so the answer never misreports how big the
 * department actually is.
 */
const MAX_LISTED = 25;

function boundedNames(names: string[]): string {
  if (names.length === 0) return "none";
  if (names.length <= MAX_LISTED) return names.join(", ");
  return `${names.slice(0, MAX_LISTED).join(", ")}, and ${names.length - MAX_LISTED} more`;
}

const DEPARTMENT_NOT_FOUND = "I could not find a department by that name.";
const NO_ACTIVE_TERM_DEPARTMENT =
  "There is no active clinic term right now, so department rosters do not apply.";
const DEPARTMENT_ACCESS_DENIED = "You do not have access to that department's roster.";

const NO_ACTIVE_TERM_MEMBER =
  "There is no active clinic term right now, so membership status does not apply.";

/**
 * Returned for every negative outcome once an active term exists: the caller
 * has no departmental standing anywhere, the name/netId matches nobody, it
 * matches more than one person, or it matches a real person whose only active
 * memberships sit in departments the caller cannot see. These are
 * deliberately collapsed into one exact string -- see the byte-identical
 * assertion in roster.test.ts -- because distinguishing any of them would let
 * anyone who can chat with Fin enumerate real members by probing names and
 * reading which refusal came back, turning the tool into a directory-
 * enumeration oracle.
 */
const CANNOT_CONFIRM_MEMBERSHIP =
  "I could not confirm an active membership for that person in a department you have access to.";

async function resolveDepartment(input: string): Promise<{ id: string; name: string } | null> {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const exact = await prisma.department.findFirst({
    where: {
      OR: [
        { code: { equals: trimmed, mode: "insensitive" } },
        { name: { equals: trimmed, mode: "insensitive" } },
      ],
    },
    select: { id: true, name: true },
  });
  if (exact) return exact;

  // A loose fallback is safe here in a way it would not be for a person below:
  // department names are not private, so resolving "internal med" to Internal
  // Medicine (or refusing outright when more than one department matches)
  // never leaks anything a caller could not already see on the schedule page.
  const loose = await prisma.department.findMany({
    where: { name: { contains: trimmed, mode: "insensitive" } },
    select: { id: true, name: true },
    take: 2,
  });
  return loose.length === 1 ? loose[0] : null;
}

type PersonCandidate = { id: string; name: string; contactEmail: string | null; phone: string | null };

async function resolvePerson(input: string): Promise<PersonCandidate | null> {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const select = { id: true, name: true, contactEmail: true, phone: true } as const;

  const byNetId = await prisma.person.findFirst({
    where: { netId: { equals: trimmed, mode: "insensitive" } },
    select,
  });
  if (byNetId) return byNetId;

  // Exact name match only, and only when it resolves to exactly ONE person.
  // Unlike the department fallback above, guessing wrong about a PERSON is
  // the exact oracle this tool exists to avoid, so an ambiguous name is
  // treated identically to no match at all (see CANNOT_CONFIRM_MEMBERSHIP).
  const byName = await prisma.person.findMany({
    where: { name: { equals: trimmed, mode: "insensitive" } },
    select,
    take: 2,
  });
  return byName.length === 1 ? byName[0] : null;
}

/**
 * "Who is on the Nursing team?" -- the roster question a director or ops lead
 * actually asks, scoped to one department they can see.
 */
export const departmentRosterTool: McpTool = {
  name: "department_roster",
  title: "Department roster",
  description:
    "The active directors and volunteers in one department this term. Use for questions like 'who is on the Nursing team?', 'who directs Triage?', or 'how many volunteers does SCTP have?'. Only works for a department the caller has departmental visibility into (typically one they direct); it is not a general clinic-wide directory.",
  inputSchema: z.object({
    department: z
      .string()
      .describe("The department's name or code, e.g. 'Nursing' or 'NURS' -- never an internal id."),
  }),
  run: async (ctx, args) => {
    const { department: query } = args as { department: string };

    const department = await resolveDepartment(query);
    if (!department) return DEPARTMENT_NOT_FOUND;

    const term = await getActiveTerm();
    if (!term) return NO_ACTIVE_TERM_DEPARTMENT;

    // The authorization check. See the file-level comment for why the
    // fallback must be permissionDepartmentIds and not can(ctx.personId,
    // "volunteers.view"), and for what hasPlatformScope must never do.
    const platformScoped = await hasPlatformScope(ctx.personId, "volunteers.view", term.id);
    if (!platformScoped) {
      const visibleDeptIds = await permissionDepartmentIds(ctx.personId, "volunteers.view", term.id);
      if (!visibleDeptIds.includes(department.id)) return DEPARTMENT_ACCESS_DENIED;
    }

    const memberships = await prisma.termMembership.findMany({
      where: { termId: term.id, departmentId: department.id, status: "ACTIVE" },
      select: { kind: true, person: { select: { name: true } } },
    });

    const directors = memberships
      .filter((m) => m.kind === "DIRECTOR")
      .map((m) => m.person.name)
      .sort((a, b) => a.localeCompare(b));
    const volunteers = memberships
      .filter((m) => m.kind === "VOLUNTEER")
      .map((m) => m.person.name)
      .sort((a, b) => a.localeCompare(b));

    // A platform-scoped caller can legitimately land here for a department
    // with nobody in it this term -- hasPlatformScope clears them for every
    // department, not just ones they have a row in. For everyone else this
    // still should not normally happen: permissionDepartmentIds only ever
    // includes a department the caller is THEMSELVES an ACTIVE member of
    // (department- and kind-targeted assignments are only fetched for
    // departments/kinds present in the caller's own active memberships, and a
    // person-targeted grant is explicitly scoped to "every department they
    // are an active member of" -- see its doc comment), so a department that
    // clears the check above always has at least the caller's own row. Kept
    // as a real branch, not an assertion, so a future change to that
    // invariant fails toward an honest answer instead of an empty list read
    // as "there is nobody here".
    if (directors.length === 0 && volunteers.length === 0) {
      return `${department.name} has no active members this term.`;
    }

    return `${department.name} this term -- ${directors.length} director(s): ${boundedNames(directors)}. ${volunteers.length} volunteer(s): ${boundedNames(volunteers)}.`;
  },
};

/**
 * "Is Jane Doe an active volunteer?" -- the natural single-person counterpart
 * to departmentRosterTool, for a caller who already knows who they mean.
 */
export const memberStatusTool: McpTool = {
  name: "member_status",
  title: "Member status",
  description:
    "Whether a named person is an active clinic member this term, and which department(s) they belong to. Use for questions like 'is Jane Doe an active volunteer?' or 'what department is jdoe23 in?'. Only reports on departments the caller has visibility into, and only confirms or denies membership within that scope.",
  inputSchema: z.object({
    name: z.string().describe("The person's full name or Yale NetID to look up -- never an internal id."),
  }),
  run: async (ctx, args) => {
    const { name: query } = args as { name: string };

    const term = await getActiveTerm();
    if (!term) return NO_ACTIVE_TERM_MEMBER;

    // Deny-by-default, and cheaply for the non-platform-scoped case: a caller
    // with no departmental standing AND no platform scope gets refused before
    // this even looks up the name, and reads identically to every other
    // refusal path below (see CANNOT_CONFIRM_MEMBERSHIP). A platform-scoped
    // caller (see the file-level comment) skips this department-membership
    // gate entirely -- that is the point of the widening -- so
    // visibleDeptIds stays null for them rather than being computed.
    const platformScoped = await hasPlatformScope(ctx.personId, "volunteers.view", term.id);
    const visibleDeptIds: string[] | null = platformScoped
      ? null
      : await permissionDepartmentIds(ctx.personId, "volunteers.view", term.id);
    if (visibleDeptIds !== null && visibleDeptIds.length === 0) return CANNOT_CONFIRM_MEMBERSHIP;

    const candidate = await resolvePerson(query);
    if (!candidate) return CANNOT_CONFIRM_MEMBERSHIP; // no match, or an ambiguous one -- never guess

    const memberships = await prisma.termMembership.findMany({
      where: { personId: candidate.id, termId: term.id, status: "ACTIVE" },
      select: { kind: true, department: { select: { id: true, name: true } } },
    });
    const visible =
      visibleDeptIds === null ? memberships : memberships.filter((m) => visibleDeptIds.includes(m.department.id));
    // Same message whether the person does not exist, is not an active member
    // anywhere, or is active only in a department this caller cannot see --
    // the caller must not be able to tell those apart from the reply.
    if (visible.length === 0) return CANNOT_CONFIRM_MEMBERSHIP;

    const roles = visible
      .map((m) => `${m.kind === "DIRECTOR" ? "Director" : "Volunteer"} in ${m.department.name}`)
      .sort((a, b) => a.localeCompare(b));

    let answer = `${candidate.name} is an active member this term: ${roles.join("; ")}.`;

    // admin.manage_people is the ONLY permission that shows contactEmail/phone
    // to anyone but the record's own owner anywhere in the Hub UI -- see the
    // file-level comment. Checked last and purely additively.
    if (await can(ctx.personId, "admin.manage_people")) {
      const contact = [
        candidate.contactEmail ? `email ${candidate.contactEmail}` : null,
        candidate.phone ? `phone ${candidate.phone}` : null,
      ].filter((v): v is string => v !== null);
      if (contact.length > 0) answer += ` Contact: ${contact.join(", ")}.`;
    }

    return answer;
  },
};
