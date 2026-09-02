import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { resolveAudience } from "./resolve";
import type { AudienceCondition } from "./types";

beforeEach(resetDb);

async function person(name: string, email: string | null) {
  return prisma.person.create({ data: { name, contactEmail: email, status: "ACTIVE" } });
}

/**
 * Builds a cycle (unless one is passed), an Applicant, and a submitted
 * Application, mirroring `cycleWithApplicant` in resolve.test.ts -- the fixture
 * the appliedToCycle tests already rely on for the email/NetID fallback. Any
 * extras (subcommittee assignment, acceptance) are layered on afterward by the
 * caller so this stays a single shared builder rather than three near-copies.
 */
async function cycleWithApplication(opts: {
  personId?: string;
  email: string;
  netId?: string;
  cycleId?: string;
  assignedSubcommitteeId?: string;
  track?: "VOLUNTEER" | "DIRECTOR";
  status?: "DRAFT" | "SUBMITTED" | "WITHDRAWN";
  applicantType?: "NEW" | "RENEWAL" | "TRANSFER";
  decision?: "PENDING" | "ACCEPT" | "REJECT" | "WAITLIST";
}) {
  let cycleId = opts.cycleId;
  if (!cycleId) {
    const t = await prisma.term.create({
      data: {
        code: `T${Math.random().toString(36).slice(2, 8)}`,
        name: "T",
        startDate: new Date("2026-08-25"),
        endDate: new Date("2026-12-20"),
        status: "PLANNING",
      },
    });
    const creator = await person(
      "Cycle Creator",
      `creator-${Math.random().toString(36).slice(2, 8)}@example.com`,
    );
    const c = await prisma.recruitmentCycle.create({
      data: {
        track: opts.track ?? "VOLUNTEER",
        term: { connect: { id: t.id } },
        createdBy: { connect: { id: creator.id } },
        title: "Fall 2026",
        publicSlug: `slug-${Math.random().toString(36).slice(2, 8)}`,
      },
    });
    cycleId = c.id;
  }
  const applicant = await prisma.applicant.create({
    data: {
      cycleId,
      applicantPersonId: opts.personId ?? null,
      firstName: "A",
      lastName: "B",
      email: opts.email,
      emailLower: opts.email.toLowerCase(),
      netId: opts.netId ?? null,
    },
  });
  const application = await prisma.application.create({
    data: {
      cycleId,
      applicantId: applicant.id,
      answers: {},
      assignedSubcommitteeId: opts.assignedSubcommitteeId ?? null,
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.status === "WITHDRAWN" ? { withdrawnAt: new Date("2026-09-01T12:00:00.000Z") } : {}),
      ...(opts.applicantType ? { applicantType: opts.applicantType } : {}),
      ...(opts.decision ? { decision: opts.decision } : {}),
    },
  });
  return { cycleId, applicationId: application.id };
}

async function acceptFor(applicationId: string, approvedById: string) {
  return prisma.acceptance.create({
    data: {
      applicationId,
      departmentCode: "CARDIO",
      approvedById,
    },
  });
}

/**
 * An Interview row in one of its two meaningful states.
 *
 * `invitedAt` defaults to null because that is what `createInterview` actually
 * writes (interviews.ts) -- the row is created with no time and no invite, and
 * `sendInterviewInvite` stamps `invitedAt` later. Tests that want "the applicant
 * was told" must pass it explicitly, which is the whole distinction
 * interviewInvitedInCycle exists to make.
 */
async function interviewFor(
  applicationId: string,
  createdById: string,
  opts: {
    invitedAt?: Date | null;
    decision?: "PENDING" | "ACCEPT" | "REJECT" | "WAITLIST";
    departmentCode?: string;
  } = {},
) {
  return prisma.interview.create({
    data: {
      applicationId,
      departmentCode: opts.departmentCode ?? "CARDIO",
      createdById,
      scheduledAt: opts.invitedAt ? new Date("2026-09-10T15:00:00.000Z") : null,
      invitedAt: opts.invitedAt ?? null,
      ...(opts.decision ? { decision: opts.decision } : {}),
    },
  });
}

async function emailsFor(condition: AudienceCondition): Promise<string[]> {
  const res = await resolveAudience({
    recordType: "PERSON",
    match: "ALL",
    conditions: [condition],
  });
  return res.recipients.map((r) => r.email);
}

describe("resolveAudience acceptedInCycle", () => {
  it("matches a signed-in applicant (linked via applicantPersonId) once an Acceptance exists", async () => {
    const p = await person("Renewer", "renew@example.com");
    const approver = await person("Approver", "approver@example.com");
    const { cycleId, applicationId } = await cycleWithApplication({
      personId: p.id,
      email: "renew@example.com",
    });
    await acceptFor(applicationId, approver.id);

    const res = await resolveAudience({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "acceptedInCycle", op: "in", value: [cycleId] }],
    });
    expect(res.recipients.map((r) => r.email)).toEqual(["renew@example.com"]);
  });

  it("matches an ANONYMOUS applicant, linked only by lowercased email", async () => {
    // applicantPersonId is null for anyone who applied anonymously. Matching
    // only the link would UNDER-match: a regression that drops the email
    // fallback must fail this test.
    await person("Anon", "Anon.Applicant@Example.com");
    const approver = await person("Approver", "approver2@example.com");
    const { cycleId, applicationId } = await cycleWithApplication({
      email: "anon.applicant@example.com",
    });
    await acceptFor(applicationId, approver.id);

    const res = await resolveAudience({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "acceptedInCycle", op: "in", value: [cycleId] }],
    });
    expect(res.recipients.map((r) => r.email)).toEqual(["Anon.Applicant@Example.com"]);
  });

  it("does NOT match a person whose application has no Acceptance", async () => {
    const p = await person("Pending", "pending@example.com");
    const { cycleId } = await cycleWithApplication({
      personId: p.id,
      email: "pending@example.com",
    });

    const res = await resolveAudience({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "acceptedInCycle", op: "in", value: [cycleId] }],
    });
    expect(res.recipients).toEqual([]);
  });

  it("matches nobody for a deleted/unknown cycle id rather than throwing", async () => {
    const p = await person("Someone", "someone@example.com");
    const approver = await person("Approver", "approver3@example.com");
    const { applicationId } = await cycleWithApplication({
      personId: p.id,
      email: "someone@example.com",
    });
    await acceptFor(applicationId, approver.id);

    const res = await resolveAudience({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "acceptedInCycle", op: "in", value: ["does-not-exist"] }],
    });
    expect(res.recipients).toEqual([]);
  });
});

describe("resolveAudience subcommittee", () => {
  it("matches via the assigned application", async () => {
    const p = await person("Assigned", "assigned@example.com");
    const sub = await prisma.subcommittee.create({ data: { name: "Fundraising" } });
    await cycleWithApplication({
      personId: p.id,
      email: "assigned@example.com",
      assignedSubcommitteeId: sub.id,
    });

    const res = await resolveAudience({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "subcommittee", op: "in", value: [sub.id] }],
    });
    expect(res.recipients.map((r) => r.email)).toEqual(["assigned@example.com"]);
  });

  it("matches an ANONYMOUS applicant's subcommittee assignment, linked only by lowercased email", async () => {
    await person("Anon Sub", "Anon.Sub@Example.com");
    const sub = await prisma.subcommittee.create({ data: { name: "Events" } });
    await cycleWithApplication({
      email: "anon.sub@example.com",
      assignedSubcommitteeId: sub.id,
    });

    const res = await resolveAudience({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "subcommittee", op: "in", value: [sub.id] }],
    });
    expect(res.recipients.map((r) => r.email)).toEqual(["Anon.Sub@Example.com"]);
  });

  it("does not match a person whose application was never assigned a subcommittee", async () => {
    const p = await person("Unassigned", "unassigned@example.com");
    const sub = await prisma.subcommittee.create({ data: { name: "Outreach" } });
    await cycleWithApplication({ personId: p.id, email: "unassigned@example.com" });

    const res = await resolveAudience({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "subcommittee", op: "in", value: [sub.id] }],
    });
    expect(res.recipients).toEqual([]);
  });

  it("matches nobody for a deleted/unknown subcommittee id rather than throwing", async () => {
    const p = await person("Someone Else", "else@example.com");
    const sub = await prisma.subcommittee.create({ data: { name: "Real" } });
    await cycleWithApplication({
      personId: p.id,
      email: "else@example.com",
      assignedSubcommitteeId: sub.id,
    });

    const res = await resolveAudience({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "subcommittee", op: "in", value: ["deleted-subcommittee-id"] }],
    });
    expect(res.recipients).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Recruitment outcome fields
// ---------------------------------------------------------------------------

/**
 * The four recruitment-outcome fields, each paired with the write that puts an
 * applicant into its cohort and the condition that asks for it.
 *
 * Table-driven rather than four near-copies because the properties below are
 * properties of the SEAM, not of any one field: every one of them resolves an
 * applicant to a Person through the same nullable link plus email/NetID
 * fallback, and every cycle-keyed one is guarded by the same pre-seeded bucket.
 * A field added later that quietly grows its own weaker resolution fails here
 * the moment it is added to this list, which a per-field copy would not do.
 */
type OutcomeField =
  | "rejectedInCycle"
  | "interviewInvitedInCycle"
  | "withdrewFromCycle"
  | "applicantType";

const OUTCOME_FIELDS: OutcomeField[] = [
  "rejectedInCycle",
  "interviewInvitedInCycle",
  "withdrewFromCycle",
  "applicantType",
];

/** The cycle-keyed subset: applicantType is enum-kind and names no cycle. */
const CYCLE_KEYED_OUTCOME_FIELDS = OUTCOME_FIELDS.filter((f) => f !== "applicantType");

/** Puts the application into `field`'s cohort, by the same write the app makes. */
async function putInCohort(
  field: OutcomeField,
  applicationId: string,
  staffId: string,
): Promise<void> {
  switch (field) {
    case "rejectedInCycle":
      await prisma.application.update({
        where: { id: applicationId },
        data: { decision: "REJECT", decidedById: staffId, decidedAt: new Date() },
      });
      return;
    case "interviewInvitedInCycle":
      await interviewFor(applicationId, staffId, { invitedAt: new Date("2026-09-02T12:00:00.000Z") });
      return;
    case "withdrewFromCycle":
      await prisma.application.update({
        where: { id: applicationId },
        data: { status: "WITHDRAWN", withdrawnAt: new Date() },
      });
      return;
    case "applicantType":
      await prisma.application.update({
        where: { id: applicationId },
        data: { applicantType: "RENEWAL" },
      });
      return;
  }
}

/** The condition that asks for `field`'s cohort in `cycleId`. */
function conditionFor(field: OutcomeField, cycleId: string): AudienceCondition {
  return field === "applicantType"
    ? { field, op: "eq", value: "RENEWAL" }
    : { field, op: "in", value: [cycleId] };
}

/**
 * The property that makes the entire precompute correct, asserted for every new
 * field rather than for a favourite one.
 *
 * An application does not reliably link to a Person: `Applicant.applicantPersonId`
 * is set only for signed-in renewals and is null for everyone who applied
 * anonymously. A field that matched only the link would UNDER-match, which on an
 * "exclude people we already rejected" condition means telling them twice.
 */
describe.each(OUTCOME_FIELDS)("%s resolves an UNLINKED applicant", (field) => {
  it("back to a Person by email, case-insensitively", async () => {
    const staff = await person("Staff", "staff@example.com");
    // The Person's stored address differs from the applicant's only in case,
    // which is the whole point: emailLower is what the applicant row carries.
    await person("Anon", "Outcome.Anon@Example.com");
    // A second Person with no application at all, so the assertion pins WHICH
    // person matched rather than merely counting one.
    await person("Bystander", "bystander@example.com");
    const { cycleId, applicationId } = await cycleWithApplication({
      email: "outcome.anon@example.com",
    });
    await putInCohort(field, applicationId, staff.id);

    expect(await emailsFor(conditionFor(field, cycleId))).toEqual(["Outcome.Anon@Example.com"]);
  });

  it("back to a Person by NetID when the email does not match at all", async () => {
    // Yale sends an alias address, so the applicant's email need not match the
    // one on file; the NetID still does.
    const staff = await person("Staff", "staff@example.com");
    const p = await person("Aliased", "alias@example.com");
    await prisma.person.update({ where: { id: p.id }, data: { netId: "ab123" } });
    await person("Bystander", "bystander@example.com");
    const { cycleId, applicationId } = await cycleWithApplication({
      email: "other@yale.edu",
      netId: "ab123",
    });
    await putInCohort(field, applicationId, staff.id);

    expect(await emailsFor(conditionFor(field, cycleId))).toEqual(["alias@example.com"]);
  });
});

/**
 * Every outcome stays keyed to the cycle it happened in.
 *
 * The fixture puts TWO cycles in play and records the outcome in only one of
 * them, then asks about each in turn. Two cycles rather than one is what makes
 * this discriminating: the buckets are pre-seeded from the ids the audience
 * NAMED, so with a single cycle requested there is exactly one bucket and a
 * compiler that ignored the requested key entirely -- unioning every bucket --
 * would give the identical answer. The companion `appliedToCycle` condition
 * names both cycles, so both are seeded, and the two readings finally diverge.
 */
describe.each(CYCLE_KEYED_OUTCOME_FIELDS)("%s stays keyed to the cycle it happened in", (field) => {
  it("does not match an outcome recorded in a cycle the condition did not name", async () => {
    const staff = await person("Staff", "staff@example.com");
    const p = await person("Elsewhere", "elsewhere@example.com");
    const quiet = await cycleWithApplication({
      personId: p.id,
      email: "elsewhere@example.com",
    });
    // A SECOND cycle, with its own applicant row for the same Person, carrying
    // the outcome.
    const loud = await cycleWithApplication({
      personId: p.id,
      email: "elsewhere@example.com",
    });
    await putInCohort(field, loud.applicationId, staff.id);

    // Names BOTH cycles, so both end up seeded in every cycle bucket.
    const bothCycles: AudienceCondition = {
      field: "appliedToCycle",
      op: "in",
      value: [quiet.cycleId, loud.cycleId],
    };
    const ask = async (cycleId: string) =>
      (
        await resolveAudience({
          recordType: "PERSON",
          match: "ALL",
          conditions: [conditionFor(field, cycleId), bothCycles],
        })
      ).recipients.map((r) => r.email);

    expect(await ask(quiet.cycleId)).toEqual([]);
    // ... and the same person IS matched when the condition names the cycle the
    // outcome actually happened in, so the assertion above is not passing
    // because the fixture never produced a match at all.
    expect(await ask(loud.cycleId)).toEqual(["elsewhere@example.com"]);
  });
});

describe("resolveAudience rejectedInCycle", () => {
  /**
   * A rejection has TWO sources by design and both have to be read.
   * `Application.decision` is the routed department's decision on a VOLUNTEER
   * application (no interview); `Interview.decision` is the director-track
   * decision. The schema comment on Application.decision says exactly this. A
   * test covering only one source would pass against an implementation that
   * silently dropped a whole track.
   */
  it("matches a VOLUNTEER rejection recorded on Application.decision", async () => {
    const staff = await person("Staff", "staff@example.com");
    const rejected = await person("Volunteer Rejected", "vol.rejected@example.com");
    const kept = await person("Volunteer Pending", "vol.pending@example.com");
    const { cycleId, applicationId } = await cycleWithApplication({
      personId: rejected.id,
      email: "vol.rejected@example.com",
      track: "VOLUNTEER",
    });
    await cycleWithApplication({
      personId: kept.id,
      email: "vol.pending@example.com",
      cycleId,
    });
    await prisma.application.update({
      where: { id: applicationId },
      data: { decision: "REJECT", decidedById: staff.id, decidedAt: new Date() },
    });

    expect(await emailsFor({ field: "rejectedInCycle", op: "in", value: [cycleId] })).toEqual([
      "vol.rejected@example.com",
    ]);
  });

  it("matches a DIRECTOR rejection recorded on Interview.decision", async () => {
    const staff = await person("Staff", "staff@example.com");
    const rejected = await person("Director Rejected", "dir.rejected@example.com");
    const kept = await person("Director Pending", "dir.pending@example.com");
    const { cycleId, applicationId } = await cycleWithApplication({
      personId: rejected.id,
      email: "dir.rejected@example.com",
      track: "DIRECTOR",
    });
    const other = await cycleWithApplication({
      personId: kept.id,
      email: "dir.pending@example.com",
      cycleId,
    });
    // Application.decision stays PENDING on the director track: the decision
    // lives on the Interview. Reading only Application.decision drops this row.
    await interviewFor(applicationId, staff.id, {
      invitedAt: new Date("2026-09-02T12:00:00.000Z"),
      decision: "REJECT",
    });
    await interviewFor(other.applicationId, staff.id, {
      invitedAt: new Date("2026-09-02T12:00:00.000Z"),
    });

    expect(await emailsFor({ field: "rejectedInCycle", op: "in", value: [cycleId] })).toEqual([
      "dir.rejected@example.com",
    ]);
  });

  it("matches BOTH tracks from one condition", async () => {
    const staff = await person("Staff", "staff@example.com");
    const vol = await person("Vol", "both.vol@example.com");
    const dir = await person("Dir", "both.dir@example.com");
    const volApp = await cycleWithApplication({
      personId: vol.id,
      email: "both.vol@example.com",
    });
    const dirApp = await cycleWithApplication({
      personId: dir.id,
      email: "both.dir@example.com",
      cycleId: volApp.cycleId,
    });
    await prisma.application.update({
      where: { id: volApp.applicationId },
      data: { decision: "REJECT", decidedById: staff.id, decidedAt: new Date() },
    });
    await interviewFor(dirApp.applicationId, staff.id, { decision: "REJECT" });

    expect(
      (await emailsFor({ field: "rejectedInCycle", op: "in", value: [volApp.cycleId] })).sort(),
    ).toEqual(["both.dir@example.com", "both.vol@example.com"]);
  });

  it("does not match an accepted, waitlisted, or undecided application", async () => {
    const staff = await person("Staff", "staff@example.com");
    const accepted = await person("Accepted", "acc@example.com");
    const waitlisted = await person("Waitlisted", "wait@example.com");
    const pending = await person("Pending", "pend@example.com");
    const first = await cycleWithApplication({
      personId: accepted.id,
      email: "acc@example.com",
      decision: "ACCEPT",
    });
    await cycleWithApplication({
      personId: waitlisted.id,
      email: "wait@example.com",
      cycleId: first.cycleId,
      decision: "WAITLIST",
    });
    const pendingApp = await cycleWithApplication({
      personId: pending.id,
      email: "pend@example.com",
      cycleId: first.cycleId,
    });
    // A PENDING interview on the undecided one, so "has an interview" alone
    // cannot be mistaken for a rejection.
    await interviewFor(pendingApp.applicationId, staff.id, {
      invitedAt: new Date("2026-09-02T12:00:00.000Z"),
    });

    expect(await emailsFor({ field: "rejectedInCycle", op: "in", value: [first.cycleId] })).toEqual(
      [],
    );
  });
});

describe("resolveAudience interviewInvitedInCycle", () => {
  /**
   * The distinction the field name exists to make. `createInterview` writes a
   * row with no `scheduledAt` and no `invitedAt`; `sendInterviewInvite` stamps
   * `invitedAt` only when the invite actually goes out. A bare row is internal
   * state the applicant never saw, so matching on the ROW would mail people
   * about an interview nobody has told them about.
   */
  it("does NOT match a bare Interview row whose invitedAt is null", async () => {
    const staff = await person("Staff", "staff@example.com");
    const p = await person("Not Told", "nottold@example.com");
    const { cycleId, applicationId } = await cycleWithApplication({
      personId: p.id,
      email: "nottold@example.com",
      track: "DIRECTOR",
    });
    await interviewFor(applicationId, staff.id);

    expect(
      await emailsFor({ field: "interviewInvitedInCycle", op: "in", value: [cycleId] }),
    ).toEqual([]);
  });

  it("matches only once the invite has been sent", async () => {
    const staff = await person("Staff", "staff@example.com");
    const told = await person("Told", "told@example.com");
    const notTold = await person("Not Told", "nottold@example.com");
    const first = await cycleWithApplication({
      personId: told.id,
      email: "told@example.com",
      track: "DIRECTOR",
    });
    const second = await cycleWithApplication({
      personId: notTold.id,
      email: "nottold@example.com",
      cycleId: first.cycleId,
    });
    await interviewFor(first.applicationId, staff.id, {
      invitedAt: new Date("2026-09-02T12:00:00.000Z"),
    });
    await interviewFor(second.applicationId, staff.id);

    expect(
      await emailsFor({ field: "interviewInvitedInCycle", op: "in", value: [first.cycleId] }),
    ).toEqual(["told@example.com"]);
  });

  it("matches when any one of several department interviews was sent", async () => {
    const staff = await person("Staff", "staff@example.com");
    const p = await person("Multi", "multi@example.com");
    const { cycleId, applicationId } = await cycleWithApplication({
      personId: p.id,
      email: "multi@example.com",
      track: "DIRECTOR",
    });
    await interviewFor(applicationId, staff.id, { departmentCode: "CARDIO" });
    await interviewFor(applicationId, staff.id, {
      departmentCode: "DERM",
      invitedAt: new Date("2026-09-02T12:00:00.000Z"),
    });

    expect(
      await emailsFor({ field: "interviewInvitedInCycle", op: "in", value: [cycleId] }),
    ).toEqual(["multi@example.com"]);
  });
});

describe("resolveAudience withdrewFromCycle", () => {
  it("matches an application whose status is WITHDRAWN", async () => {
    const gone = await person("Withdrew", "withdrew@example.com");
    const stayed = await person("Stayed", "stayed@example.com");
    const first = await cycleWithApplication({
      personId: gone.id,
      email: "withdrew@example.com",
      status: "WITHDRAWN",
    });
    await cycleWithApplication({
      personId: stayed.id,
      email: "stayed@example.com",
      cycleId: first.cycleId,
    });

    expect(await emailsFor({ field: "withdrewFromCycle", op: "in", value: [first.cycleId] })).toEqual(
      ["withdrew@example.com"],
    );
  });

  it("stops matching once staff reopen the withdrawal", async () => {
    // reopenWithdrawnApplication (withdraw.ts) writes status and withdrawnAt
    // back together, so the status is the state and the stamp cannot outlive it.
    const p = await person("Reopened", "reopened@example.com");
    const { cycleId, applicationId } = await cycleWithApplication({
      personId: p.id,
      email: "reopened@example.com",
      status: "WITHDRAWN",
    });
    expect(await emailsFor({ field: "withdrewFromCycle", op: "in", value: [cycleId] })).toEqual([
      "reopened@example.com",
    ]);

    await prisma.application.update({
      where: { id: applicationId },
      data: { status: "SUBMITTED", withdrawnAt: null },
    });
    expect(await emailsFor({ field: "withdrewFromCycle", op: "in", value: [cycleId] })).toEqual([]);
  });
});

describe("resolveAudience applicantType", () => {
  it("matches only the selected type", async () => {
    const renewal = await person("Renewal", "renewal@example.com");
    const fresh = await person("New", "new@example.com");
    const transfer = await person("Transfer", "transfer@example.com");
    const first = await cycleWithApplication({
      personId: renewal.id,
      email: "renewal@example.com",
      applicantType: "RENEWAL",
    });
    await cycleWithApplication({
      personId: fresh.id,
      email: "new@example.com",
      cycleId: first.cycleId,
      applicantType: "NEW",
    });
    await cycleWithApplication({
      personId: transfer.id,
      email: "transfer@example.com",
      cycleId: first.cycleId,
      applicantType: "TRANSFER",
    });

    expect(await emailsFor({ field: "applicantType", op: "eq", value: "RENEWAL" })).toEqual([
      "renewal@example.com",
    ]);
    expect(
      (await emailsFor({ field: "applicantType", op: "in", value: ["NEW", "TRANSFER"] })).sort(),
    ).toEqual(["new@example.com", "transfer@example.com"]);
  });

  it("spans cycles, since the type is a property of the application and not of a cycle", async () => {
    const a = await person("Renewal A", "renewal.a@example.com");
    const b = await person("Renewal B", "renewal.b@example.com");
    await cycleWithApplication({
      personId: a.id,
      email: "renewal.a@example.com",
      applicantType: "RENEWAL",
    });
    // A SEPARATE cycle: no cycle is named by this condition, so both must match.
    await cycleWithApplication({
      personId: b.id,
      email: "renewal.b@example.com",
      applicantType: "RENEWAL",
    });

    expect((await emailsFor({ field: "applicantType", op: "eq", value: "RENEWAL" })).sort()).toEqual(
      ["renewal.a@example.com", "renewal.b@example.com"],
    );
  });

  it("does NOT match a DRAFT application, which is not an application yet", async () => {
    // saveDraft (drafts.ts) creates the Application row at DRAFT with an
    // applicantType already set, so somebody who only opened the wizard would
    // otherwise be mailed as though they had applied.
    const drafter = await person("Drafter", "drafter@example.com");
    await cycleWithApplication({
      personId: drafter.id,
      email: "drafter@example.com",
      applicantType: "RENEWAL",
      status: "DRAFT",
    });

    expect(await emailsFor({ field: "applicantType", op: "eq", value: "RENEWAL" })).toEqual([]);
  });

  it("still matches an applicant who applied and then withdrew", async () => {
    // They did apply as a renewal; withdrewFromCycle is the field that separates
    // them, not this one.
    const p = await person("Withdrawn Renewal", "wr@example.com");
    await cycleWithApplication({
      personId: p.id,
      email: "wr@example.com",
      applicantType: "RENEWAL",
      status: "WITHDRAWN",
    });

    expect(await emailsFor({ field: "applicantType", op: "eq", value: "RENEWAL" })).toEqual([
      "wr@example.com",
    ]);
  });

  it("matches nobody for a type that is not in the enum, rather than throwing", async () => {
    const p = await person("Renewal", "renewal@example.com");
    await cycleWithApplication({
      personId: p.id,
      email: "renewal@example.com",
      applicantType: "RENEWAL",
    });

    expect(await emailsFor({ field: "applicantType", op: "eq", value: "GRADUATE" })).toEqual([]);
  });
});
