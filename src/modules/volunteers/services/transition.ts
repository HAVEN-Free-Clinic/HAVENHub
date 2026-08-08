/**
 * Term transition report: who on the current roster is coming back next term.
 *
 * Derived live, with no stored state and no schema of its own. The inputs are
 * the ACTIVE term's roster, the next PLANNING term's roster, and the
 * applications attached to that next term's recruitment cycles.
 *
 * This module deliberately sits beside offboarding.ts rather than inside it.
 * offboarding.ts answers "flag and execute one person"; this answers "who is
 * going where next term". Keeping them apart also means a director opening the
 * Flagged tab does not pay for this roll-up.
 *
 * Read-only. The bulk mutations live in transition-actions.ts and loop the
 * per-person functions in offboarding.ts.
 */

import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { manageableDepartmentIds } from "@/platform/departments";
import { getActiveTerm } from "@/platform/terms/active-term";
import { getNextTerm } from "@/platform/terms/next-term";
import { yaleEmailForNetId } from "@/platform/auth/match-person";

export type TransitionBucket = "RETURNING" | "PENDING" | "NOT_RETURNING";

export type TermRef = { id: string; code: string; name: string };

export type TransitionRow = {
  personId: string;
  name: string;
  netId: string | null;
  contactEmail: string | null;
  /** ACTIVE memberships in the CURRENT term, for display and for the CSV. */
  departments: { code: string; name: string }[];
  /** DIRECTOR when any current membership is a directorship. */
  role: "DIRECTOR" | "VOLUNTEER";
  bucket: TransitionBucket;
  /** A DRAFT application exists for the next term. Does not change the bucket. */
  hasDraftApplication: boolean;
  /**
   * A WITHDRAWN application exists for the next term. Kept separate from
   * hasDraftApplication: someone who applied and then withdrew is a confirmed
   * departure, which is stronger evidence than never applying, and calling that
   * a draft in progress would say the opposite of what happened.
   */
  withdrewApplication: boolean;
  /** An OffboardFlag already exists for this person in the current term. */
  flagged: boolean;
  /** That flag was raised by the person themselves (self-withdrawal). */
  selfWithdrew: boolean;
  /** False for RETURNING rows, which this tab must not sweep into a bulk action. */
  selectable: boolean;
};

export type TransitionView = {
  activeTerm: TermRef | null;
  nextTerm: TermRef | null;
  rows: TransitionRow[];
};

function termRef(term: { id: string; code: string; name: string }): TermRef {
  return { id: term.id, code: term.code, name: term.name };
}

export async function transitionView(viewerPersonId: string): Promise<TransitionView> {
  const activeTerm = await getActiveTerm();
  if (!activeTerm) return { activeTerm: null, nextTerm: null, rows: [] };

  const nextTerm = await getNextTerm();
  if (!nextTerm) return { activeTerm: termRef(activeTerm), nextTerm: null, rows: [] };

  // Same visibility split offboardingView already applies: the permission sees
  // clinic-wide, a director sees their own departments plus one-hop delegations.
  const isExecutor = await can(viewerPersonId, "volunteers.manage_offboarding");
  let departmentScope: string[] | null = null;
  if (!isExecutor) {
    departmentScope = await manageableDepartmentIds(viewerPersonId);
    if (departmentScope.length === 0) {
      return { activeTerm: termRef(activeTerm), nextTerm: termRef(nextTerm), rows: [] };
    }
  }

  const memberships = await prisma.termMembership.findMany({
    where: {
      termId: activeTerm.id,
      status: "ACTIVE",
      ...(departmentScope ? { departmentId: { in: departmentScope } } : {}),
    },
    include: {
      person: { select: { id: true, name: true, netId: true, contactEmail: true } },
      department: { select: { code: true, name: true } },
    },
  });

  const personIds = [...new Set(memberships.map((m) => m.personId))];
  if (personIds.length === 0) {
    return { activeTerm: termRef(activeTerm), nextTerm: termRef(nextTerm), rows: [] };
  }

  // Every lowercase address that could identify one of these people in an
  // Applicant row, mapped back to the person. Both the stored contact address
  // and the derived Yale address, because an anonymous applicant is matched by
  // whichever one they typed.
  const personByEmail = new Map<string, string>();
  const rosterEmails: string[] = [];
  for (const m of memberships) {
    const candidates = [
      m.person.contactEmail?.trim().toLowerCase(),
      m.person.netId ? yaleEmailForNetId(m.person.netId) : null,
    ];
    for (const email of candidates) {
      if (!email || personByEmail.has(email)) continue;
      personByEmail.set(email, m.personId);
      rosterEmails.push(email);
    }
  }

  const [nextMemberships, applications, flags] = await Promise.all([
    prisma.termMembership.findMany({
      where: { personId: { in: personIds }, termId: nextTerm.id, status: "ACTIVE" },
      select: { personId: true },
    }),
    // Bounded by the roster, not by cycle size: a cycle can carry 700
    // applications, and only the ones naming a current member matter here.
    prisma.application.findMany({
      where: {
        cycle: { termId: nextTerm.id },
        OR: [
          { applicant: { applicantPersonId: { in: personIds } } },
          ...(rosterEmails.length > 0
            ? [{ applicant: { emailLower: { in: rosterEmails } } }]
            : []),
        ],
      },
      select: {
        status: true,
        applicant: { select: { applicantPersonId: true, emailLower: true } },
      },
    }),
    prisma.offboardFlag.findMany({
      where: { personId: { in: personIds }, termId: activeTerm.id },
      select: { personId: true, flaggedById: true },
    }),
  ]);

  const returningIds = new Set(nextMemberships.map((m) => m.personId));

  const submittedIds = new Set<string>();
  const draftIds = new Set<string>();
  const withdrawnIds = new Set<string>();
  for (const app of applications) {
    // applicantPersonId is the clean link and is always set for RENEWAL and
    // TRANSFER (both gate on being signed in). emailLower is the fallback for an
    // anonymous NEW applicant, whose misclassification as NOT_RETURNING would
    // feed a default-checked bulk flag.
    const personId =
      app.applicant.applicantPersonId ?? personByEmail.get(app.applicant.emailLower) ?? null;
    if (!personId) continue;
    // Explicit per status rather than an else: ApplicationStatus is
    // DRAFT | SUBMITTED | WITHDRAWN, and lumping WITHDRAWN in with DRAFT would
    // tell a director that a confirmed departure is still mid-application.
    if (app.status === "SUBMITTED") submittedIds.add(personId);
    else if (app.status === "DRAFT") draftIds.add(personId);
    else if (app.status === "WITHDRAWN") withdrawnIds.add(personId);
  }

  const flagByPersonId = new Map(flags.map((f) => [f.personId, f]));

  const byPerson = new Map<string, typeof memberships>();
  for (const m of memberships) {
    const list = byPerson.get(m.personId) ?? [];
    list.push(m);
    byPerson.set(m.personId, list);
  }

  const rows: TransitionRow[] = [];
  for (const personId of personIds) {
    const personMemberships = byPerson.get(personId) ?? [];
    if (personMemberships.length === 0) continue;
    const person = personMemberships[0].person;
    const flag = flagByPersonId.get(personId) ?? null;

    const bucket: TransitionBucket = returningIds.has(personId)
      ? "RETURNING"
      : submittedIds.has(personId)
        ? "PENDING"
        : "NOT_RETURNING";

    rows.push({
      personId,
      name: person.name,
      netId: person.netId,
      contactEmail: person.contactEmail,
      departments: [
        ...new Map(
          personMemberships.map((m) => [m.department.code, m.department])
        ).values(),
      ].sort((a, b) => a.code.localeCompare(b.code)),
      role: personMemberships.some((m) => m.kind === "DIRECTOR") ? "DIRECTOR" : "VOLUNTEER",
      bucket,
      hasDraftApplication: draftIds.has(personId),
      withdrewApplication: withdrawnIds.has(personId),
      flagged: flag !== null,
      selfWithdrew: flag?.flaggedById === personId,
      selectable: bucket !== "RETURNING",
    });
  }

  rows.sort((a, b) => a.name.localeCompare(b.name));

  return { activeTerm: termRef(activeTerm), nextTerm: termRef(nextTerm), rows };
}
