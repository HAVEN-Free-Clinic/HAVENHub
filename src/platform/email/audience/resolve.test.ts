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

  it("ignores an applicant with no submitted application", async () => {
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
