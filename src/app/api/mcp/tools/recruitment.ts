import { z } from "zod";
import type { Track } from "@prisma/client";
import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { isCycleOpen } from "@/modules/recruitment/services/cycle-window";
import { getApplicantStatus } from "@/modules/recruitment/services/portal-status";
import { formatDateTime } from "@/platform/dates";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import type { McpTool } from "./index";

/**
 * Phase 4: the last tool phase, and the one that overlaps genuinely
 * confidential data. An applicant's score, interview notes, and decision are
 * not merely "permissioned" -- they are material that tells a real person
 * their own standing, or a third party someone ELSE's standing, and every
 * answer here can render straight into a member's chat with Fin, un-audited
 * from the applicant's side and impossible to take back once sent.
 *
 * So this file ships only two tools, both chosen because their failure mode
 * is bounded even in the worst case:
 *
 * - recruitmentCycleStatusTool answers a cycle-WIDE, AGGREGATE question ("is
 *   it open, when does it close, how many so far") gated on
 *   recruitment.manage_cycles. It never names an applicant and never accepts
 *   one as input, so there is nothing here for a probing question to extract.
 *   Deliberately NOT gated on reviewScope: a director's scope is a
 *   department-shaped lens on WHICH applications they may review, not a
 *   license to a Hub-wide application count that spans departments they have
 *   no standing in -- see reviewScope's doc comment in ./services/review.ts.
 *   recruitment.manage_cycles is the permission that already owns exactly
 *   this surface (src/app/(app)/recruitment/cycles/[id]/page.tsx gates the
 *   same applicant-count breakdown on it), so this reuses that decision
 *   rather than inventing a second one.
 *
 * - myApplicationStatusTool answers a SELF-scoped question ("what's the
 *   status of MY application") for the verified caller only, by reusing
 *   getApplicantStatus -- the exact function that already decides what an
 *   applicant may learn about their own file (release-gated NOT_SELECTED,
 *   emailedAt-gated ACCEPTED, no interview link, no internal evaluation --
 *   see that function's own doc comment). This can never disagree with what
 *   the applicant already sees on their own /apply/status page, and it never
 *   reaches another applicant's row: identity comes from ctx.personId alone,
 *   never from an input.
 *
 * Deliberately NOT built: anything that returns another applicant's score,
 * ranking, interview notes, or decision, even to a fully-scoped reviewer.
 * reviewScope(personId) and isInterviewPanelist(personId) (see
 * src/app/(app)/layout.tsx for how the app itself decides who counts as a
 * reviewer or panelist) are exactly the primitives such a tool would need for
 * authorization, and reusing them would not be hard -- the reason to stop
 * here is not missing plumbing, it is that Fin's answer is a one-way,
 * unaudited disclosure straight into a chat transcript, and no scoped-review
 * permission changes that a rejected applicant, or a third party fishing
 * about someone else's application, could learn a real decision through a
 * support bot instead of the reviewer UI (which shows exactly who is looking
 * and logs it). A smaller, obviously-correct tool set here is the successful
 * outcome; padding it out with a reviewer-facing applicant lookup is not.
 *
 * Applicant identity, investigated and NOT weakened: resolveIdentityFromConversation
 * (src/platform/intercom/identity.ts) requires getActivePerson to succeed,
 * i.e. Person.status === "ACTIVE". More fundamentally, IntercomMessenger only
 * mounts from the (app) layout -- "never boots on the public apply portal"
 * (see its own doc comment) -- so a true anonymous applicant who has never
 * signed in to the Hub cannot open a Fin conversation AT ALL, not merely fail
 * identity resolution once they try. submitApplication (services/submissions.ts)
 * only sets Applicant.applicantPersonId when the submitter was signed in at
 * submit time (a RENEWAL/TRANSFER, which requires it, or a NEW application
 * submitted while already matched to a Person); a first-time, unauthenticated
 * NEW applicant's row keeps applicantPersonId null forever. The population
 * myApplicationStatusTool can reach is therefore exactly: current or former
 * Hub members who applied while signed in. A true outside applicant cannot
 * use this tool, cannot reach Fin to try, and this file does not add an
 * email- or name-based lookup path to work around that -- doing so would
 * reopen exactly the identity spoofing surface the conversation-id design
 * exists to close. (getApplicantStatus's OR-on-email fallback still gets
 * exercised here for a narrower, safe reason: a NEW applicant who applied
 * anonymously and was LATER promoted to an active member can have their old
 * application surfaced once their Hub account's contactEmail matches the
 * address they originally applied under -- see myApplicationStatusTool below.)
 */

function trackLabel(track: Track): string {
  return track === "DIRECTOR" ? "Director" : "Volunteer";
}

/**
 * Bounds how many concurrently OPEN cycles one answer can list. In practice
 * this is at most one per Track (see the Track enum), so the cap is
 * defensive, not load-bearing -- but every list-shaped tool in this MCP
 * surface bounds its output on principle (see MAX_LISTED in roster.ts).
 */
const MAX_CYCLES = 5;

const CYCLE_ACCESS_DENIED = "You do not have access to recruitment cycle status.";

/**
 * "Is recruitment open right now?" -- deliberately takes no input. A cycle
 * TITLE is not itself confidential the way an applicant's data is, but there
 * is no support reason to let the model probe for one by name either, so this
 * simply reports on every currently-OPEN cycle rather than accepting a lookup
 * key at all. That also means there is nothing here shaped like the
 * cross-subject "refusal must not confirm existence" concern phase 3 tools
 * carry: the only refusal path is the permission gate below, and it is the
 * same text whether or not any cycle is actually open.
 */
export const recruitmentCycleStatusTool: McpTool = {
  name: "recruitment_cycle_status",
  title: "Recruitment cycle status",
  description:
    "Whether a recruitment cycle is currently open, when it closes, and how many applications it has received so far. Use for questions like 'is recruitment open right now?', 'when does the volunteer application close?', or 'how many people have applied this cycle?'. Reports cycle-wide totals only, never individual applicants.",
  inputSchema: z.object({}),
  run: async (ctx) => {
    // The one authorization check. See the file-level comment for why this is
    // recruitment.manage_cycles and not reviewScope.
    if (!(await can(ctx.personId, "recruitment.manage_cycles"))) {
      return CYCLE_ACCESS_DENIED;
    }

    const cycles = await prisma.recruitmentCycle.findMany({
      where: { status: "OPEN" },
      // status is re-selected (even though the WHERE already pins it to OPEN)
      // purely so isCycleOpen below can take the row shape it declares, rather
      // than each caller having to re-assert the literal.
      select: { id: true, title: true, track: true, status: true, opensAt: true, closesAt: true },
      orderBy: { createdAt: "desc" },
      take: MAX_CYCLES,
    });
    if (cycles.length === 0) return "There is no recruitment cycle open right now.";

    const zone = await getDisplayTimeZone();
    const now = new Date();
    const lines = await Promise.all(
      cycles.map(async (cycle) => {
        // Only SUBMITTED counts as "applied" -- an in-progress draft is not an
        // application yet, and a withdrawn one is no longer live, so neither
        // belongs in an answer to "how many people have applied".
        const submitted = await prisma.application.count({ where: { cycleId: cycle.id, status: "SUBMITTED" } });
        const label = `${cycle.title} (${trackLabel(cycle.track)})`;
        const countPhrase = `${submitted} application${submitted === 1 ? "" : "s"} so far`;

        // opensAt/closesAt are true instants (an admin picks a specific time of
        // day, see setApplicationWindowAction), not an all-day calendar marker
        // like clinicDate, so they render with the zoned formatDateTime -- the
        // same choice the cycle overview page's <DateTime> makes for the same
        // fields.
        const beforeOpen = cycle.opensAt !== null && cycle.opensAt > now;
        const afterClose = cycle.closesAt !== null && cycle.closesAt < now;
        // Status is already filtered to OPEN above, so isCycleOpen here is
        // exactly !beforeOpen && !afterClose -- reusing it (rather than just
        // inlining that boolean) keeps this answer from ever disagreeing with
        // the one function the apply form itself gates submission on.
        const live = isCycleOpen(cycle, now);
        if (!live) {
          if (beforeOpen) {
            return `${label} is scheduled to open ${formatDateTime(cycle.opensAt, zone)}; not yet accepting applications. ${countPhrase}.`;
          }
          if (afterClose) {
            return `${label}'s application window closed ${formatDateTime(cycle.closesAt, zone)}; no longer accepting new applications. ${countPhrase}.`;
          }
          // Cannot normally happen: status is OPEN and isCycleOpen returned
          // false, which by construction means beforeOpen or afterClose (see
          // isCycleOpen's own definition). Fail toward an honest generic line
          // rather than a thrown error if that invariant is ever violated.
          return `${label} is not currently accepting applications. ${countPhrase}.`;
        }
        const closesPhrase = cycle.closesAt ? `closes ${formatDateTime(cycle.closesAt, zone)}` : "has no set closing date";
        return `${label} is open now and ${closesPhrase}. ${countPhrase}.`;
      })
    );
    return lines.join(" ");
  },
};

/** Bounds how many of the caller's own applications one answer lists. */
const MAX_APPLICATIONS = 5;

const NO_APPLICATION_ON_FILE = "I could not find a recruitment application on file for you.";

/**
 * "What's the status of my application?" -- self-scoped, so unlike every
 * other question this file considers, telling the truth here cannot leak
 * anyone else's standing. See the file-level comment for exactly which
 * applicants this can and cannot reach.
 */
export const myApplicationStatusTool: McpTool = {
  name: "my_application_status",
  title: "My application status",
  description:
    "The signed-in member's own recruitment application(s): submitted, under review, interview scheduled, or decided. Use for questions like 'what's the status of my application?', 'did I get in?', or 'is my application still under review?'. Only ever reports the caller's own application, never anyone else's.",
  inputSchema: z.object({}),
  run: async (ctx) => {
    // getApplicantStatus matches on personId OR email. personId covers the
    // normal case (see the file-level comment: RENEWAL/TRANSFER and any NEW
    // application submitted while signed in). The email fallback exists for
    // the narrower case of an applicant who applied anonymously and was later
    // promoted to a member -- their Applicant row never gets a retroactive
    // applicantPersonId link, so only their now-current contact address can
    // still find it. contactEmail can be null; passing "" then just means the
    // OR degrades to personId-only matching, never an accidental match on some
    // other row's blank field (Applicant.emailLower is always a real address).
    const person = await prisma.person.findUnique({
      where: { id: ctx.personId },
      select: { contactEmail: true },
    });
    const statuses = await getApplicantStatus({
      email: (person?.contactEmail ?? "").toLowerCase(),
      personId: ctx.personId,
      firstName: null,
    });
    if (statuses.length === 0) return NO_APPLICATION_ON_FILE;

    const shown = statuses.slice(0, MAX_APPLICATIONS);
    const lines = shown.map((s) => `${s.cycleTitle}: ${s.headline}.${s.detail ? ` ${s.detail}` : ""}`);
    const omitted = statuses.length - shown.length;
    return omitted > 0
      ? `${lines.join(" ")} (${omitted} more application${omitted === 1 ? "" : "s"} not shown.)`
      : lines.join(" ");
  },
};
