import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { resolveAudience } from "./resolve";
import type { Audience } from "./types";

beforeEach(resetDb);

const DAY = 24 * 60 * 60 * 1000;

async function person(name: string, email: string | null, status: "ACTIVE" | "OFFBOARDED" = "ACTIVE") {
  return prisma.person.create({ data: { name, contactEmail: email, status } });
}

async function cert(
  personId: string,
  completionDate: Date | null,
  // Dated certs default to verified so they resolve to their date-based status;
  // pass null to exercise the awaiting-verification gate.
  verifiedAt: Date | null = completionDate ? new Date() : null,
) {
  return prisma.hipaaCertificate.create({
    data: {
      personId,
      fileName: "c.pdf",
      storedName: "c.pdf",
      size: 1,
      mimeType: "application/pdf",
      completionDate,
      verifiedAt,
    },
  });
}

describe("resolveAudience (PERSON)", () => {
  it("returns recipients matching the where and excludes blank emails", async () => {
    await person("Active One", "one@example.com", "ACTIVE");
    await person("Active NoEmail", null, "ACTIVE");
    await person("Offboarded", "off@example.com", "OFFBOARDED");

    const res = await resolveAudience({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "status", op: "eq", value: "ACTIVE" }],
    });

    expect(res.recipients.map((r) => r.email).sort()).toEqual(["one@example.com"]);
    expect(res.excludedNoEmail).toBe(1);
    expect(res.recipients[0].variables).toEqual({ firstName: "Active", name: "Active One" });
    expect(res.recipients[0].recordType).toBe("PERSON");
  });

  it("empty conditions resolve to zero recipients", async () => {
    await person("Someone", "s@example.com");
    const res = await resolveAudience({ recordType: "PERSON", match: "ALL", conditions: [] });
    expect(res.recipients).toEqual([]);
  });
});

describe("resolveAudience compliance status (issue #72)", () => {
  // No active term is created, so the term bar is absent and a certificate is
  // COMPLIANT iff it expires more than 60 days from now.
  it("COMPLIANT matches people whose live status is compliant", async () => {
    const now = Date.now();

    const compliant = await person("Compliant", "compliant@example.com");
    await cert(compliant.id, new Date(now - 30 * DAY)); // expires now+335d -> COMPLIANT

    const expired = await person("Expired", "expired@example.com");
    await cert(expired.id, new Date(now - 400 * DAY)); // expires now-35d -> EXPIRED

    await person("No Cert", "nocert@example.com"); // NO_CERTIFICATE

    const res = await resolveAudience({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "complianceStatus", op: "in", value: ["COMPLIANT"] }],
    });

    expect(res.recipients.map((r) => r.email)).toEqual(["compliant@example.com"]);
  });

  it("matches derived statuses even when no ComplianceReminder rows exist", async () => {
    const now = Date.now();

    const expired = await person("Expired", "expired@example.com");
    await cert(expired.id, new Date(now - 400 * DAY)); // EXPIRED

    await person("No Cert", "nocert@example.com"); // NO_CERTIFICATE

    const compliant = await person("Compliant", "compliant@example.com");
    await cert(compliant.id, new Date(now - 30 * DAY)); // COMPLIANT, excluded

    const res = await resolveAudience({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "complianceStatus", op: "in", value: ["EXPIRED", "NO_CERTIFICATE"] }],
    });

    expect(res.recipients.map((r) => r.email).sort()).toEqual([
      "expired@example.com",
      "nocert@example.com",
    ]);
  });

  it("composes with other conditions (ALL)", async () => {
    const now = Date.now();

    const active = await person("Active Compliant", "active@example.com", "ACTIVE");
    await cert(active.id, new Date(now - 30 * DAY)); // COMPLIANT

    const offboarded = await person("Offboarded Compliant", "off@example.com", "OFFBOARDED");
    await cert(offboarded.id, new Date(now - 30 * DAY)); // COMPLIANT but offboarded

    const res = await resolveAudience({
      recordType: "PERSON",
      match: "ALL",
      conditions: [
        { field: "status", op: "eq", value: "ACTIVE" },
        { field: "complianceStatus", op: "in", value: ["COMPLIANT"] },
      ],
    });

    expect(res.recipients.map((r) => r.email)).toEqual(["active@example.com"]);
  });

  it("PENDING_VERIFICATION matches people with a dated but unverified cert", async () => {
    const now = Date.now();

    const pending = await person("Pending", "pending@example.com");
    // Date would otherwise read COMPLIANT, but no human has verified it.
    await cert(pending.id, new Date(now - 30 * DAY), null);

    const compliant = await person("Compliant", "compliant@example.com");
    await cert(compliant.id, new Date(now - 30 * DAY)); // verified -> COMPLIANT, excluded

    const res = await resolveAudience({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "complianceStatus", op: "in", value: ["PENDING_VERIFICATION"] }],
    });

    expect(res.recipients.map((r) => r.email)).toEqual(["pending@example.com"]);
  });
});

describe("resolveAudience clearance + nested groups", () => {
  async function activeTerm() {
    return prisma.term.create({
      data: {
        code: "SU26",
        name: "Summer 2026",
        startDate: new Date("2026-05-01"),
        endDate: new Date("2026-09-26"),
        status: "ACTIVE",
      },
    });
  }

  it("isCleared=true matches fully-cleared active-term members", async () => {
    const term = await activeTerm();
    const dept = await prisma.department.create({ data: { code: "PCAR", name: "Primary Care" } });

    const cleared = await prisma.person.create({
      data: { name: "Cleared", contactEmail: "cleared@x.edu", phone: "555-1", status: "ACTIVE" },
    });
    await prisma.termMembership.create({
      data: { personId: cleared.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" },
    });
    await cert(cleared.id, new Date()); // valid + verified -> COMPLIANT

    const notCleared = await prisma.person.create({
      data: { name: "NotCleared", contactEmail: "notcleared@x.edu", phone: "555-2", status: "ACTIVE" },
    });
    await prisma.termMembership.create({
      data: { personId: notCleared.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" },
    });
    // no cert -> HIPAA incomplete -> not cleared

    const res = await resolveAudience({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "isCleared", op: "isTrue" }],
    });
    expect(res.recipients.map((r) => r.email)).toEqual(["cleared@x.edu"]);
  });

  it("resolves a nested group (ANY of a plain condition OR a nested ALL group)", async () => {
    const term = await activeTerm();
    const dept = await prisma.department.create({ data: { code: "PCAR", name: "Primary Care" } });

    const volRn = await prisma.person.create({
      data: { name: "Vol RN", contactEmail: "volrn@x.edu", status: "ACTIVE", licensedRN: true },
    });
    await prisma.termMembership.create({
      data: { personId: volRn.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" },
    });
    const volNonRn = await prisma.person.create({
      data: { name: "Vol NonRN", contactEmail: "volnonrn@x.edu", status: "ACTIVE", licensedRN: false },
    });
    await prisma.termMembership.create({
      data: { personId: volNonRn.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" },
    });

    // ANY of: status=OFFBOARDED, OR (role=VOLUNTEER AND licensedRN). Only volRn qualifies.
    const res = await resolveAudience({
      recordType: "PERSON",
      match: "ANY",
      conditions: [
        { field: "status", op: "eq", value: "OFFBOARDED" },
        {
          match: "ALL",
          children: [
            { field: "role", op: "eq", value: "VOLUNTEER" },
            { field: "licensedRN", op: "isTrue" },
          ],
        },
      ],
    });
    expect(res.recipients.map((r) => r.email)).toEqual(["volrn@x.edu"]);
  });
});

// ---------------------------------------------------------------------------
// Past-term targeting (the campaign this feature was built for)
// ---------------------------------------------------------------------------

describe("resolveAudience across terms", () => {
  async function term(code: string, status: "ACTIVE" | "ARCHIVED" | "PLANNING", start: string) {
    return prisma.term.create({
      data: {
        code,
        name: code,
        startDate: new Date(start),
        endDate: new Date(new Date(start).getTime() + 90 * DAY),
        status,
      },
    });
  }

  async function dept(code: string) {
    return prisma.department.create({ data: { code, name: code } });
  }

  async function member(
    personId: string,
    termId: string,
    departmentId: string,
    kind: "VOLUNTEER" | "DIRECTOR" = "VOLUNTEER",
    status: "ACTIVE" | "REMOVED" = "ACTIVE",
  ) {
    return prisma.termMembership.create({
      data: { personId, termId, departmentId, kind, status },
    });
  }

  it("targets volunteers from two PAST terms while a later term is active", async () => {
    // The exact ask: "email all spring and summer volunteers about re-applying",
    // sent during the fall term. Neither cohort is reachable through the
    // active-term default this field used to be locked to.
    const sp = await term("SP26", "ARCHIVED", "2026-01-10");
    const su = await term("SU26", "ARCHIVED", "2026-05-20");
    const fa = await term("FA26", "ACTIVE", "2026-08-25");
    const d = await dept("CARDIO");

    const spring = await person("Spring Vol", "spring@example.com");
    const summer = await person("Summer Vol", "summer@example.com");
    const both = await person("Both Terms", "both@example.com");
    const fall = await person("Fall Vol", "fall@example.com");
    const springDirector = await person("Spring Dir", "dir@example.com");

    await member(spring.id, sp.id, d.id);
    await member(summer.id, su.id, d.id);
    await member(both.id, sp.id, d.id);
    await member(both.id, su.id, d.id);
    await member(fall.id, fa.id, d.id);
    await member(springDirector.id, sp.id, d.id, "DIRECTOR");

    const res = await resolveAudience({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "role", op: "eq", value: "VOLUNTEER", terms: [sp.id, su.id] }],
    });

    // Each person appears once even when they served both terms, the fall-only
    // volunteer is out, and the spring DIRECTOR is out.
    expect(res.recipients.map((r) => r.email).sort()).toEqual([
      "both@example.com",
      "spring@example.com",
      "summer@example.com",
    ]);
  });

  it("still reaches people who were offboarded after an archived term", async () => {
    // Offboarding only touches non-archived terms (OFFBOARDABLE_TERM), so an
    // archived roster keeps its ACTIVE memberships and stays targetable even
    // though Person.status is now OFFBOARDED.
    const sp = await term("SP26", "ARCHIVED", "2026-01-10");
    const d = await dept("CARDIO");
    const alum = await person("Alum", "alum@example.com", "OFFBOARDED");
    await member(alum.id, sp.id, d.id);

    const res = await resolveAudience({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "onRoster", op: "isTrue", terms: [sp.id] }],
    });
    expect(res.recipients.map((r) => r.email)).toEqual(["alum@example.com"]);
  });

  it("does not let two conditions be satisfied by different membership rows", async () => {
    // A director in spring who volunteers in fall must NOT match "spring
    // volunteer" -- the whole reason the term scope rides on the condition.
    const sp = await term("SP26", "ARCHIVED", "2026-01-10");
    const fa = await term("FA26", "ACTIVE", "2026-08-25");
    const d = await dept("CARDIO");
    const p = await person("Switcher", "switch@example.com");
    await member(p.id, sp.id, d.id, "DIRECTOR");
    await member(p.id, fa.id, d.id, "VOLUNTEER");

    const res = await resolveAudience({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "role", op: "eq", value: "VOLUNTEER", terms: [sp.id] }],
    });
    expect(res.recipients).toEqual([]);
  });

  it("excludes a removed membership from a past-term roster", async () => {
    const sp = await term("SP26", "ARCHIVED", "2026-01-10");
    const d = await dept("CARDIO");
    const p = await person("Removed", "removed@example.com");
    await member(p.id, sp.id, d.id, "VOLUNTEER", "REMOVED");

    const res = await resolveAudience({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "onRoster", op: "isTrue", terms: [sp.id] }],
    });
    expect(res.recipients).toEqual([]);
  });

  it("a NONE group subtracts a cohort from a term audience", async () => {
    const sp = await term("SP26", "ARCHIVED", "2026-01-10");
    const d = await dept("CARDIO");
    const keep = await person("Keep", "keep@example.com");
    const drop = await person("Drop", "drop@example.com");
    await member(keep.id, sp.id, d.id);
    await member(drop.id, sp.id, d.id);
    await prisma.person.update({ where: { id: drop.id }, data: { licensedRN: true } });

    const res = await resolveAudience({
      recordType: "PERSON",
      match: "ALL",
      conditions: [
        { field: "onRoster", op: "isTrue", terms: [sp.id] },
        { match: "NONE", children: [{ field: "licensedRN", op: "isTrue" }] },
      ],
    });
    expect(res.recipients.map((r) => r.email)).toEqual(["keep@example.com"]);
  });

  // The database-level version of the compile.test.ts proof: a date condition
  // in a NONE group used to be reachable, via the audience builder's default,
  // with an operator ("eq") its own field never declares. personFieldWhere's
  // gate turns that into MATCH_NOBODY, and compileGroup renders NONE as
  // `NOT { OR: fragments }`, so a NONE group holding only that condition
  // matched every Person in the table -- including people who joined well
  // after the cutoff the admin typed in, which is the opposite of "exclude
  // people who joined on or after June 1". With `defaultConditionFor` now
  // handing a date field a real operator (onOrAfter), the exact same shape of
  // condition -- a NONE group holding one date condition -- correctly excludes
  // only the people it names.
  it("a NONE group with a well-formed date condition excludes only the intended people, not everyone", async () => {
    const early = await person("Early", "early@example.com");
    await prisma.person.update({ where: { id: early.id }, data: { createdAt: new Date("2026-01-01T12:00:00.000Z") } });
    const late = await person("Late", "late@example.com");
    await prisma.person.update({ where: { id: late.id }, data: { createdAt: new Date("2026-07-01T12:00:00.000Z") } });

    const res = await resolveAudience({
      recordType: "PERSON",
      match: "ALL",
      conditions: [
        { match: "NONE", children: [{ field: "joinedAt", op: "onOrAfter", value: "2026-06-01" }] },
      ],
    });
    // Not everyone: "Late" (joined June or after) is excluded, "Early" is kept.
    expect(res.recipients.map((r) => r.email)).toEqual(["early@example.com"]);
  });
});

// ---------------------------------------------------------------------------
// appliedToCycle: the "skip people who already re-applied" exclusion
// ---------------------------------------------------------------------------

describe("resolveAudience appliedToCycle", () => {
  async function cycleWithApplicant(opts: {
    personId?: string;
    email: string;
    netId?: string;
    cycleId?: string;
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
      const creator = await person("Cycle Creator", `creator-${Math.random().toString(36).slice(2, 8)}@example.com`);
      const c = await prisma.recruitmentCycle.create({
        data: {
          track: "VOLUNTEER",
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
    await prisma.application.create({
      data: { cycleId, applicantId: applicant.id, answers: {} },
    });
    return cycleId;
  }

  it("matches an applicant linked to a Person", async () => {
    const p = await person("Renewer", "renew@example.com");
    const cycleId = await cycleWithApplicant({ personId: p.id, email: "renew@example.com" });

    const res = await resolveAudience({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "appliedToCycle", op: "in", value: [cycleId] }],
    });
    expect(res.recipients.map((r) => r.email)).toEqual(["renew@example.com"]);
  });

  it("matches an UNLINKED applicant back to a Person by email, case-insensitively", async () => {
    // applicantPersonId is null for anyone who applied anonymously. Matching only
    // the link would under-match and re-nag people who already applied.
    await person("Anon", "Anon.Applicant@Example.com");
    const cycleId = await cycleWithApplicant({ email: "anon.applicant@example.com" });

    const res = await resolveAudience({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "appliedToCycle", op: "in", value: [cycleId] }],
    });
    expect(res.recipients.map((r) => r.email)).toEqual(["Anon.Applicant@Example.com"]);
  });

  it("matches an unlinked applicant by NetID when the email differs", async () => {
    // Yale sends an alias address, so the applicant's email need not match the
    // one on file; the NetID still does.
    const p = await person("Aliased", "alias@example.com");
    await prisma.person.update({ where: { id: p.id }, data: { netId: "ab123" } });
    const cycleId = await cycleWithApplicant({ email: "other@yale.edu", netId: "ab123" });

    const res = await resolveAudience({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "appliedToCycle", op: "in", value: [cycleId] }],
    });
    expect(res.recipients.map((r) => r.email)).toEqual(["alias@example.com"]);
  });

  it("subtracts already-applied people from a past-term audience", async () => {
    // The complete re-apply campaign: spring volunteers who have NOT applied yet.
    const sp = await prisma.term.create({
      data: {
        code: "SP26",
        name: "SP26",
        startDate: new Date("2026-01-10"),
        endDate: new Date("2026-05-01"),
        status: "ARCHIVED",
      },
    });
    const d = await prisma.department.create({ data: { code: "CARDIO", name: "Cardio" } });
    const applied = await person("Applied", "applied@example.com");
    const notYet = await person("Not Yet", "notyet@example.com");
    for (const p of [applied, notYet]) {
      await prisma.termMembership.create({
        data: { personId: p.id, termId: sp.id, departmentId: d.id, kind: "VOLUNTEER" },
      });
    }
    const cycleId = await cycleWithApplicant({ personId: applied.id, email: "applied@example.com" });

    const res = await resolveAudience({
      recordType: "PERSON",
      match: "ALL",
      conditions: [
        { field: "role", op: "eq", value: "VOLUNTEER", terms: [sp.id] },
        { field: "appliedToCycle", op: "notIn", value: [cycleId] },
      ],
    });
    expect(res.recipients.map((r) => r.email)).toEqual(["notyet@example.com"]);
  });

  /**
   * Today's DRAFT behaviour, pinned deliberately rather than left accidental.
   *
   * `loadApplicantFacts` selects applicants on `applications: { some: {} }` with
   * no status predicate, so an Application row created by the wizard's autosave
   * counts as having applied. Both halves of that are real and neither is
   * obviously right:
   *
   *   - `in`  MAILS someone whose only row is an autosaved draft. A "thanks for
   *     applying, here is what happens next" campaign lands in the inbox of
   *     somebody who never submitted.
   *   - `notIn` correspondingly EXCLUDES that person from a "you have not
   *     applied yet" nudge, which is the one message they actually need.
   *
   * Recorded, NOT endorsed. It is left alone here because `appliedToCycle` is
   * usable inside an `AudienceScope`, and a scope is a send BOUNDARY: narrowing
   * this shrinks reach under `in` but WIDENS it under `notIn` and inside a NONE
   * group, so it needs a scope-by-scope audit rather than a one-line edit. The
   * edit itself would be one line -- `applications: { some: { status: { not:
   * "DRAFT" } } }` in loadApplicantFacts -- and is safe on the data model,
   * since `Application` is unique on (cycleId, applicantId) so a draft-only
   * applicant has exactly one row, and every other bucket built from that scan
   * is already stricter (a draft can reach none of their states: routing.ts,
   * interviews.ts, interview-decisions.ts and withdraw.ts all refuse a
   * non-SUBMITTED application).
   *
   * Whoever makes that change should get the two tests below failing, one per
   * direction, rather than a surprise in a sent campaign.
   */
  /**
   * One drafter, one real submitter, one person who never applied.
   *
   * Split across the two tests below rather than asserted in one, so a failure
   * names WHICH direction changed: the two are separate harms with separate
   * audiences, and the narrowing edit breaks both at once.
   */
  async function cycleWithADraftAndASubmission() {
    const drafter = await person("Drafter", "drafter@example.com");
    const submitter = await person("Submitter", "submitter@example.com");
    // Never applied at all. Present so the notIn assertions are answering a
    // populated query rather than passing on an empty result.
    await person("Bystander", "bystander@example.com");

    const cycleId = await cycleWithApplicant({
      personId: submitter.id,
      email: "submitter@example.com",
    });
    const drafterApplicant = await prisma.applicant.create({
      data: {
        cycleId,
        applicantPersonId: drafter.id,
        firstName: "D",
        lastName: "Rafter",
        email: "drafter@example.com",
        emailLower: "drafter@example.com",
      },
    });
    await prisma.application.create({
      data: { cycleId, applicantId: drafterApplicant.id, answers: {}, status: "DRAFT" },
    });
    return cycleId;
  }

  it("MAILS a draft-only applicant under `in` (the inclusion half)", async () => {
    const cycleId = await cycleWithADraftAndASubmission();

    const res = await resolveAudience({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "appliedToCycle", op: "in", value: [cycleId] }],
    });
    // The drafter is in the send list beside a genuine submitter. A "thanks for
    // applying, here is what happens next" campaign reaches somebody who never
    // submitted.
    expect(res.recipients.map((r) => r.email).sort()).toEqual([
      "drafter@example.com",
      "submitter@example.com",
    ]);
  });

  it("EXCLUDES a draft-only applicant under `notIn` (the exclusion half)", async () => {
    const cycleId = await cycleWithADraftAndASubmission();

    const res = await resolveAudience({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "appliedToCycle", op: "notIn", value: [cycleId] }],
    });
    const stillOffered = res.recipients.map((r) => r.email);
    // Someone who never applied is still reachable, which is what makes the two
    // absences below meaningful rather than an empty result.
    expect(stillOffered).toContain("bystander@example.com");
    // The drafter is dropped from a "you have not applied yet" nudge, which is
    // the one message they actually need.
    expect(stillOffered).not.toContain("drafter@example.com");
    expect(stillOffered).not.toContain("submitter@example.com");
  });

  it("ignores an applicant with no Application row at all", async () => {
    // Distinct from the DRAFT case above, and the weaker of the two: this
    // exercises the `applications: { some: {} }` half of the query, not the
    // status. The test used to be named for the submitted/draft distinction it
    // does not actually make.
    const p = await person("Draft Only", "draft@example.com");
    const t = await prisma.term.create({
      data: {
        code: "FA26",
        name: "FA26",
        startDate: new Date("2026-08-25"),
        endDate: new Date("2026-12-20"),
        status: "PLANNING",
      },
    });
    const creator = await person("Cycle Creator", "creator-draft@example.com");
    const c = await prisma.recruitmentCycle.create({
      data: {
        track: "VOLUNTEER",
        term: { connect: { id: t.id } },
        createdBy: { connect: { id: creator.id } },
        title: "Fall",
        publicSlug: "fall-draft",
      },
    });
    await prisma.applicant.create({
      data: {
        cycleId: c.id,
        applicantPersonId: p.id,
        firstName: "A",
        lastName: "B",
        email: "draft@example.com",
        emailLower: "draft@example.com",
      },
    });

    const res = await resolveAudience({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "appliedToCycle", op: "in", value: [c.id] }],
    });
    expect(res.recipients).toEqual([]);
  });
});

describe("scope enforcement", () => {
  async function twoPeople() {
    const inScope = await prisma.person.create({
      data: { name: "In Scope", contactEmail: "in@example.com", status: "ACTIVE" },
    });
    const outOfScope = await prisma.person.create({
      data: { name: "Out Of Scope", contactEmail: "out@example.com", status: "OFFBOARDED" },
    });
    return { inScope, outOfScope };
  }

  const ACTIVE_SCOPE: Audience = {
    recordType: "PERSON",
    match: "ALL",
    conditions: [{ field: "status", op: "eq", value: "ACTIVE" }],
  };

  it("narrows a campaign audience to the scope", async () => {
    await twoPeople();
    const everyone: Audience = {
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "name", op: "isNotEmpty" }],
    };
    const { recipients } = await resolveAudience(everyone, { scope: ACTIVE_SCOPE });
    expect(recipients.map((r) => r.email)).toEqual(["in@example.com"]);
  });

  // The bug this guards: appending the scope as a sibling CONDITION of a
  // root-ANY audience would OR it away, turning a narrowing into a widening.
  it("cannot be widened by a root-ANY campaign audience", async () => {
    await twoPeople();
    const anyOf: Audience = {
      recordType: "PERSON",
      match: "ANY",
      conditions: [
        { field: "name", op: "contains", value: "Out Of Scope" },
        { field: "name", op: "contains", value: "In Scope" },
      ],
    };
    const { recipients } = await resolveAudience(anyOf, { scope: ACTIVE_SCOPE });
    expect(recipients.map((r) => r.email)).toEqual(["in@example.com"]);
  });

  it("matches nobody when the scope is an empty tree", async () => {
    await twoPeople();
    const everyone: Audience = {
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "name", op: "isNotEmpty" }],
    };
    const emptyScope: Audience = { recordType: "PERSON", match: "ALL", conditions: [] };
    const { recipients } = await resolveAudience(everyone, { scope: emptyScope });
    expect(recipients).toEqual([]);
  });

  it("is unchanged when no scope is supplied", async () => {
    await twoPeople();
    const everyone: Audience = {
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "name", op: "isNotEmpty" }],
    };
    const { recipients } = await resolveAudience(everyone);
    expect(recipients).toHaveLength(2);
  });

  // A precompute keyed off only the campaign's conditions would leave
  // complianceStatusByPerson undefined while the SCOPE needs it, and the field
  // compiler would then resolve the scope half to nobody (or throw).
  it("runs precomputes for conditions that appear only in the scope", async () => {
    await twoPeople();
    const scopeNeedingPrecompute: Audience = {
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "complianceStatus", op: "in", value: ["NO_CERTIFICATE"] }],
    };
    const everyone: Audience = {
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "name", op: "isNotEmpty" }],
    };
    const { recipients } = await resolveAudience(everyone, { scope: scopeNeedingPrecompute });
    // Nobody has a certificate, so both people carry NO_CERTIFICATE and the
    // scope admits them. The point of the assertion is that this does not throw
    // and does not silently return zero.
    expect(recipients.length).toBeGreaterThan(0);
  });
});

describe("relative date conditions re-evaluate per run", () => {
  it("matches a different set as `now` advances", async () => {
    // A certificate completed on a fixed date. Whether it falls inside
    // "the last 7 days" depends entirely on when the run happens.
    const p = await prisma.person.create({
      data: { name: "Cert Holder", contactEmail: "cert@example.com", status: "ACTIVE" },
    });
    await prisma.hipaaCertificate.create({
      data: {
        personId: p.id,
        fileName: "c.pdf",
        storedName: "c.pdf",
        size: 1,
        mimeType: "application/pdf",
        completionDate: new Date("2026-03-10T12:00:00.000Z"),
      },
    });

    const audience: Audience = {
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "hipaaCompletedAt", op: "withinLastDays", value: "7" }],
    };

    const near = await resolveAudience(audience, { now: new Date("2026-03-12T18:00:00.000Z") });
    expect(near.recipients.map((r) => r.email)).toEqual(["cert@example.com"]);

    const far = await resolveAudience(audience, { now: new Date("2026-04-30T18:00:00.000Z") });
    expect(far.recipients).toEqual([]);
  });

  // complianceStatus is derived the same way hipaaCompletedAt's window is --
  // live, from the run's clock -- so it must resolve against opts.now too, not
  // the wall clock, for a recurring campaign to be deterministic across runs.
  it("resolves complianceStatus against the pinned `now`, not the wall clock", async () => {
    // No active term, so COMPLIANT iff expiresAt (completionDate + 365d) is at
    // least 60 days out from `now`. completionDate 2026-01-01 -> expiresAt
    // 2027-01-01.
    const p = await person("Cert Holder", "cert@example.com");
    await cert(p.id, new Date("2026-01-01T00:00:00.000Z"));

    const audience: Audience = {
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "complianceStatus", op: "in", value: ["COMPLIANT"] }],
    };

    // Well before expiresAt - 60d: COMPLIANT.
    const early = await resolveAudience(audience, { now: new Date("2026-06-01T00:00:00.000Z") });
    expect(early.recipients.map((r) => r.email)).toEqual(["cert@example.com"]);

    // Past expiresAt entirely: EXPIRED, so the COMPLIANT filter matches nobody.
    const late = await resolveAudience(audience, { now: new Date("2027-02-01T00:00:00.000Z") });
    expect(late.recipients).toEqual([]);
  });
});
