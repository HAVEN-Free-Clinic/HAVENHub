import { z } from "zod";
import type { EpicRequestStatus } from "@prisma/client";
import { prisma } from "@/platform/db";
import { getAccessTerm } from "@/platform/terms/access-term";
import { epicRequirementFor } from "@/modules/recruitment/contract/epic-requirement";
import type { McpTool } from "./index";

/**
 * "Do I have Epic access?" -- the specific follow-up my_clearance_status
 * cannot answer, because clinic clearance (getOnboardingStatus: profile,
 * HIPAA, training, learning, EHS) never covers Epic at all. A member told
 * "you are cleared" has no way to know that from Fin alone; this tool exists
 * so they can ask directly instead.
 *
 * THE HARD CONSTRAINT this whole file is built around: Epic intake requires a
 * government id and a date of birth, and none of it may reach chat (see the
 * Intercom ingest route, and listEpicTicketsWithoutRequest's doc comment in
 * src/modules/support/services/itcm.ts). This tool may report STATE --
 * whether an account exists, and where a request stands -- and nothing else.
 * It never renders Person.epicId itself, a mirror person's identity, a YNHH
 * ticket/service-request number, or any intake field. Identity comes from
 * ctx.personId only, exactly like every other tool here -- see McpToolContext
 * and the registry's identity-argument guard in index.ts.
 */

// Fix round 1, item 3: give a member a next step instead of a dead end,
// matching the shape describeRequestStatus's REJECTED sentence already uses.
const NO_REQUEST =
  "No Epic access request has been raised for you yet. Contact a human on the team if you believe you need one.";

/**
 * Plain member-facing language for a resolved (non-CANCELLED) EpicRequest
 * status. CANCELLED is handled by the caller, not here -- see
 * mostRelevantRequest's doc comment for why a cancelled request reads exactly
 * like no request at all.
 */
function describeRequestStatus(status: EpicRequestStatus): string {
  switch (status) {
    case "PENDING":
      return "A request for your Epic access has been raised but has not yet been sent to the hospital.";
    case "SUBMITTED":
      return "Your Epic access request has been submitted to Yale New Haven Hospital and is awaiting their action.";
    case "COMPLETED":
      return "Your Epic access request has been completed.";
    case "REJECTED":
      return "Yale New Haven Hospital declined your Epic access request. Contact a human on the team for next steps.";
    case "CANCELLED":
      // Excluded by mostRelevantRequest's own query filter, so this branch is
      // not reachable through the tool's normal path. Kept as a defensive
      // fallback rather than an assertion: a future caller of this function
      // that forgets the filter fails toward the honest "no request" reading
      // instead of surfacing an internal, staff-side withdrawal to a member --
      // see EpicRequestStatus.CANCELLED's own doc comment in schema.prisma
      // ("distinct from REJECTED, which means YNHH declined it").
      return NO_REQUEST;
  }
}

/**
 * The one EpicRequest, of a person's possibly several over time, that answers
 * "where does it stand right now".
 *
 * Rule: the most recently RAISED request (highest createdAt, id as a
 * deterministic tiebreaker) that is not CANCELLED and not a DEACTIVATE. Most-
 * recently-raised rather than a hand-built status-priority ranking, because it
 * is the one reading of "current" that survives every real lifecycle shape
 * without this tool having to decide which status outranks which -- a
 * REJECTED request superseded by a fresh PENDING one, or a COMPLETED request
 * from a past term followed by a RENEW raised for this one, both resolve
 * correctly just by taking the newest row. CANCELLED rows are excluded from
 * consideration entirely, not merely deprioritized: CANCELLED means WE
 * withdrew the request (see the enum's doc comment), not YNHH, so a person
 * whose latest activity is a staff-side withdrawal should read exactly like a
 * person with no request at all, never like something is unresolved on their
 * end.
 *
 * The `kind: { not: "DEACTIVATE" }` filter is LOAD-BEARING, not cosmetic --
 * do not remove it. A DEACTIVATE request revokes Epic access; it is never a
 * stage of GRANTING it. Without this filter, a PENDING or SUBMITTED
 * DEACTIVATE would render as "a request for your Epic access has been
 * raised" or "awaiting their action", and a COMPLETED one as "your Epic
 * access request has been completed" -- describing a revocation as progress
 * toward an account the member would read as good news. This is not a
 * hypothetical shape: a SUBMITTED DEACTIVATE can exist for a still-ACTIVE
 * person (reconcileDeactivationRequests, itcm.ts, can attach one to a ticket
 * for an ad-hoc deactivation), and a PENDING DEACTIVATE stranded against an
 * ACTIVE person is a real, named drift case this same codebase already
 * surfaces to staff (listStrandedDeactivations, itcm.ts). Excluding the kind
 * means such a person correctly falls through to NO_REQUEST -- the honest
 * answer, since a revocation in progress is not something the member can act
 * on and naming it risks alarming them about an internal, staff-side process.
 */
async function mostRelevantRequest(personId: string): Promise<{ status: EpicRequestStatus } | null> {
  return prisma.epicRequest.findFirst({
    where: { personId, status: { not: "CANCELLED" }, kind: { not: "DEACTIVATE" } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { status: true },
  });
}

/**
 * epicGuidance text from the person's active-term department(s), deduplicated.
 * The field exists precisely so a department can tell its own members what to
 * do about Epic (see its doc comment on Department in schema.prisma, "shown
 * as help text when the requirement is SOME") -- a dual appointment with
 * guidance set on both departments surfaces both, since either could be the
 * one that applies.
 *
 * Scoped to departments where Epic is actually relevant to this person's
 * kind -- epicRequirementFor(department, kind) !== "NONE" (ALL or SOME).
 * This tool is the first surface in the app to render epicGuidance at all,
 * and the field's own doc comment ties it to the SOME case; printing a NONE
 * department's guidance (which would mention Epic requirements the person's
 * role does not even carry) would be noise at best and confusing at worst,
 * so it is filtered out rather than shown unconditionally.
 *
 * Scoped to the access term (the live term, or the next term for someone
 * onboarded ahead of the switch -- see getAccessTerm's own doc comment),
 * matching what my_clearance_status's advisory uses this same term for.
 */
async function departmentEpicGuidance(personId: string): Promise<string[]> {
  const term = await getAccessTerm(personId);
  if (!term) return [];

  const memberships = await prisma.termMembership.findMany({
    where: { personId, termId: term.id, status: "ACTIVE" },
    select: {
      kind: true,
      department: { select: { epicGuidance: true, requiresEpicDirector: true, requiresEpicVolunteer: true } },
    },
  });

  const guidance = memberships
    .filter((m) => epicRequirementFor(m.department, m.kind) !== "NONE")
    .map((m) => m.department.epicGuidance)
    .filter((g): g is string => g !== null && g.trim() !== "");
  return [...new Set(guidance)];
}

export const myEpicStatusTool: McpTool = {
  name: "my_epic_status",
  title: "My Epic status",
  description:
    "Whether the signed-in member has an Epic (the hospital EMR) account on file, and where any Epic access request currently stands. Use for questions like 'do I have Epic access?', 'where is my Epic request?', or 'can I open a patient chart?'. Never reveals the Epic account id itself or any intake information.",
  inputSchema: z.object({}),
  run: async (ctx) => {
    const [person, request, guidance] = await Promise.all([
      prisma.person.findUniqueOrThrow({ where: { id: ctx.personId }, select: { epicId: true } }),
      mostRelevantRequest(ctx.personId),
      departmentEpicGuidance(ctx.personId),
    ]);

    // (a) Whether an account is on file. epicId being set is the signal; the
    // value itself is never printed -- see the file-level comment. This is a
    // raw on-file fact, deliberately independent of any request's kind or
    // status: Person.epicId is retained (never cleared) through a completed
    // DEACTIVATE by product decision (see completeRequest's doc comment,
    // src/modules/support/services/epic.ts), so "you have an account on
    // file" stays literally true for someone whose access was revoked. The
    // request line below is what tells them a revocation happened; this line
    // never claims their access is currently usable.
    const accountLine = person.epicId
      ? "You have an Epic account on file."
      : "You do not have an Epic account on file.";

    // (b) Where any request stands. A person with an account and no open
    // request (the common "simply set" case, e.g. request COMPLETED or no
    // request at all because the account predates request tracking) still
    // gets the request line -- it is honest rather than redundant, and
    // NO_REQUEST for that combination correctly reads as "nothing is
    // outstanding", not as a problem.
    const requestLine = request ? describeRequestStatus(request.status) : NO_REQUEST;

    // (c) Department-specific guidance, if any was set for this term.
    return [accountLine, requestLine, ...guidance].join(" ");
  },
};
