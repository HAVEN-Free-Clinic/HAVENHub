import { describe, expect, it } from "vitest";
import type { ComplianceStatus } from "@/platform/compliance/rules";
import { PERSON_FIELDS, PERSON_FIELD_VIEWS, personFieldWhere } from "./person-fields";

// Fixed clock/zone shared by tests that don't care about date behavior; kept
// separate from date-operators.test.ts's own fixture so a change there can't
// silently affect these.
const NOW = new Date("2026-01-01T12:00:00.000Z");
const ZONE = "America/New_York" as const;

const ctx = { activeTermId: "term1", now: NOW, zone: ZONE };

const complianceCtx = {
  activeTermId: "term1",
  now: NOW,
  zone: ZONE,
  complianceStatusByPerson: new Map<string, ComplianceStatus>([
    ["p1", "COMPLIANT"],
    ["p2", "EXPIRED"],
    ["p3", "COMPLIANT"],
    ["p4", "NO_CERTIFICATE"],
  ]),
};

describe("person fields", () => {
  it("exposes all expected person field keys in order", () => {
    const keys = PERSON_FIELDS.map((f) => f.key);
    expect(keys).toEqual([
      "name", "netId", "contactEmail", "epicId", "phone", "yaleAffiliation", "gradYear",
      "status", "onRoster", "role", "department", "appliedToCycle", "complianceStatus", "hasEpicId",
      "spanishVerified", "spanishSelfReported", "licensedRN", "hasOpenEpicRequest", "hasDisciplinaryAction",
      "hasApprovedStrike", "hasOpenTechTicket", "hasVerifiedCertificate", "addedToEhs",
      "completedVolunteerTraining", "flaggedForOffboarding", "isCleared", "learningComplete",
    ]);
  });

  it("status -> direct equality", () => {
    expect(personFieldWhere({ field: "status", op: "eq", value: "ACTIVE" }, ctx)).toEqual({ status: "ACTIVE" });
  });

  it("status -> an empty value matches nobody (never everyone)", () => {
    expect(personFieldWhere({ field: "status", op: "eq", value: "" }, ctx)).toEqual({ id: { in: [] } });
    expect(personFieldWhere({ field: "status", op: "eq", value: "   " }, ctx)).toEqual({ id: { in: [] } });
    expect(personFieldWhere({ field: "status", op: "eq" }, ctx)).toEqual({ id: { in: [] } });
  });

  it("role -> active-term membership of that kind", () => {
    expect(personFieldWhere({ field: "role", op: "eq", value: "DIRECTOR" }, ctx)).toEqual({
      memberships: { some: { termId: "term1", status: "ACTIVE", kind: "DIRECTOR" } },
    });
  });

  it("role -> an empty/invalid value matches nobody (never everyone)", () => {
    expect(personFieldWhere({ field: "role", op: "eq", value: "" }, ctx)).toEqual({ id: { in: [] } });
    expect(personFieldWhere({ field: "role", op: "eq", value: "   " }, ctx)).toEqual({ id: { in: [] } });
    expect(personFieldWhere({ field: "role", op: "eq" }, ctx)).toEqual({ id: { in: [] } });
    expect(personFieldWhere({ field: "role", op: "eq", value: "GHOST" }, ctx)).toEqual({ id: { in: [] } });
  });

  it("department -> active-term membership in those department codes", () => {
    expect(personFieldWhere({ field: "department", op: "in", value: ["CARDIO", "PEDS"] }, ctx)).toEqual({
      memberships: { some: { termId: "term1", status: "ACTIVE", department: { code: { in: ["CARDIO", "PEDS"] } } } },
    });
  });

  it("complianceStatus -> ids of people whose live status is selected", () => {
    expect(
      personFieldWhere({ field: "complianceStatus", op: "in", value: ["COMPLIANT"] }, complianceCtx),
    ).toEqual({ id: { in: ["p1", "p3"] } });
  });

  it("complianceStatus -> union across multiple selected statuses", () => {
    expect(
      personFieldWhere({ field: "complianceStatus", op: "in", value: ["EXPIRED", "NO_CERTIFICATE"] }, complianceCtx),
    ).toEqual({ id: { in: ["p2", "p4"] } });
  });

  it("complianceStatus -> selecting no status matches nobody", () => {
    expect(personFieldWhere({ field: "complianceStatus", op: "in", value: [] }, complianceCtx)).toEqual({
      id: { in: [] },
    });
  });

  it("complianceStatus -> throws when the status map was not precomputed", () => {
    expect(() =>
      personFieldWhere({ field: "complianceStatus", op: "in", value: ["COMPLIANT"] }, ctx),
    ).toThrow(/status map/i);
  });

  it("hasEpicId true/false", () => {
    expect(personFieldWhere({ field: "hasEpicId", op: "isTrue" }, ctx)).toEqual({ epicId: { not: null } });
    expect(personFieldWhere({ field: "hasEpicId", op: "isFalse" }, ctx)).toEqual({ epicId: null });
  });

  it("throws on an unknown field", () => {
    expect(() => personFieldWhere({ field: "bogus", op: "eq", value: "x" }, ctx)).toThrow(/Unknown audience field/);
  });
});

describe("yaleAffiliation audience field", () => {
  it("offers the 13 canonical options as an enum", () => {
    const view = PERSON_FIELD_VIEWS.find((f) => f.key === "yaleAffiliation")!;
    expect(view.kind).toBe("enum");
    expect(view.options).toHaveLength(13);
    expect(view.options?.map((o) => o.value)).toContain("ysm_md");
  });

  it("yaleAffiliation -> direct equality on the canonical key", () => {
    expect(personFieldWhere({ field: "yaleAffiliation", op: "eq", value: "ysm_md" }, ctx))
      .toEqual({ yaleAffiliation: "ysm_md" });
  });

  it("yaleAffiliation -> an empty value matches nobody (never everyone)", () => {
    expect(personFieldWhere({ field: "yaleAffiliation", op: "eq", value: "" }, ctx)).toEqual({ id: { in: [] } });
    expect(personFieldWhere({ field: "yaleAffiliation", op: "eq", value: "   " }, ctx)).toEqual({ id: { in: [] } });
    expect(personFieldWhere({ field: "yaleAffiliation", op: "eq" }, ctx)).toEqual({ id: { in: [] } });
  });
});

describe("text operators", () => {
  it("contains -> case-insensitive contains", () => {
    expect(personFieldWhere({ field: "name", op: "contains", value: "jane" }, ctx)).toEqual({
      name: { contains: "jane", mode: "insensitive" },
    });
  });

  it("eq -> case-insensitive equals", () => {
    expect(personFieldWhere({ field: "name", op: "eq", value: "Jane Doe" }, ctx)).toEqual({
      name: { equals: "Jane Doe", mode: "insensitive" },
    });
  });

  it("startsWith / endsWith -> case-insensitive", () => {
    expect(personFieldWhere({ field: "contactEmail", op: "endsWith", value: "@yale.edu" }, ctx)).toEqual({
      contactEmail: { endsWith: "@yale.edu", mode: "insensitive" },
    });
    expect(personFieldWhere({ field: "netId", op: "startsWith", value: "abc" }, ctx)).toEqual({
      netId: { startsWith: "abc", mode: "insensitive" },
    });
  });

  it("in (is any of) -> case-insensitive OR of equals from a comma/newline list", () => {
    expect(personFieldWhere({ field: "netId", op: "in", value: "abc123, def456\nghi789" }, ctx)).toEqual({
      OR: [
        { netId: { equals: "abc123", mode: "insensitive" } },
        { netId: { equals: "def456", mode: "insensitive" } },
        { netId: { equals: "ghi789", mode: "insensitive" } },
      ],
    });
  });

  it("isEmpty / isNotEmpty -> null-or-blank checks (nullable column)", () => {
    expect(personFieldWhere({ field: "epicId", op: "isEmpty" }, ctx)).toEqual({
      OR: [{ epicId: null }, { epicId: "" }],
    });
    expect(personFieldWhere({ field: "epicId", op: "isNotEmpty" }, ctx)).toEqual({
      AND: [{ epicId: { not: null } }, { epicId: { not: "" } }],
    });
  });

  // #128: Person.name is NOT NULL, so a `{ name: null }` filter throws
  // PrismaClientValidationError. The empty check must omit the null half.
  it("isEmpty / isNotEmpty on the NOT NULL name column omits the null filter", () => {
    expect(personFieldWhere({ field: "name", op: "isEmpty" }, ctx)).toEqual({ name: "" });
    expect(personFieldWhere({ field: "name", op: "isNotEmpty" }, ctx)).toEqual({ name: { not: "" } });
  });

  it("safety: a blank value operator matches nobody", () => {
    expect(personFieldWhere({ field: "name", op: "contains", value: "" }, ctx)).toEqual({ id: { in: [] } });
    expect(personFieldWhere({ field: "name", op: "contains", value: "   " }, ctx)).toEqual({ id: { in: [] } });
  });

  it("safety: an empty 'is any of' list matches nobody", () => {
    expect(personFieldWhere({ field: "netId", op: "in", value: "  , \n " }, ctx)).toEqual({ id: { in: [] } });
  });
});

describe("booleans and relations", () => {
  it("licensedRN -> direct boolean", () => {
    expect(personFieldWhere({ field: "licensedRN", op: "isTrue" }, ctx)).toEqual({ licensedRN: true });
    expect(personFieldWhere({ field: "licensedRN", op: "isFalse" }, ctx)).toEqual({ licensedRN: false });
  });

  // Language capability moved off Person into PersonLanguage, so these compile
  // to relation filters rather than column comparisons. The audience keys are
  // unchanged, so campaigns saved before the move keep working.
  it("spanishVerified -> some/none verified 'es' row", () => {
    const verifiedEs = { language: "es", verified: true, verifiedAt: { not: null } };
    expect(personFieldWhere({ field: "spanishVerified", op: "isTrue" }, ctx)).toEqual({
      languages: { some: verifiedEs },
    });
    // `none`, not `some: { verified: false }`: the false case must include
    // people with no language row at all, not only those assessed and failed.
    expect(personFieldWhere({ field: "spanishVerified", op: "isFalse" }, ctx)).toEqual({
      languages: { none: verifiedEs },
    });
  });

  it("spanishSelfReported -> some/none self-reported 'es' row", () => {
    expect(personFieldWhere({ field: "spanishSelfReported", op: "isTrue" }, ctx)).toEqual({
      languages: { some: { language: "es", selfReported: true } },
    });
    expect(personFieldWhere({ field: "spanishSelfReported", op: "isFalse" }, ctx)).toEqual({
      languages: { none: { language: "es", selfReported: true } },
    });
  });

  // #68: "open" is PENDING or SUBMITTED everywhere else in the app; matching only
  // PENDING classified an already-SUBMITTED request as "no open request".
  it("hasOpenEpicRequest -> some/none PENDING-or-SUBMITTED epic request", () => {
    expect(personFieldWhere({ field: "hasOpenEpicRequest", op: "isTrue" }, ctx)).toEqual({
      epicRequests: { some: { status: { in: ["PENDING", "SUBMITTED"] } } },
    });
    expect(personFieldWhere({ field: "hasOpenEpicRequest", op: "isFalse" }, ctx)).toEqual({
      epicRequests: { none: { status: { in: ["PENDING", "SUBMITTED"] } } },
    });
  });

  it("hasDisciplinaryAction -> some/none disciplinary action", () => {
    expect(personFieldWhere({ field: "hasDisciplinaryAction", op: "isTrue" }, ctx)).toEqual({
      disciplinaryActions: { some: {} },
    });
    expect(personFieldWhere({ field: "hasDisciplinaryAction", op: "isFalse" }, ctx)).toEqual({
      disciplinaryActions: { none: {} },
    });
  });
});

describe("PERSON_FIELD_VIEWS (RSC-serializable)", () => {
  it("mirrors PERSON_FIELDS by key, in order", () => {
    expect(PERSON_FIELD_VIEWS.map((v) => v.key)).toEqual(PERSON_FIELDS.map((f) => f.key));
  });

  it("contains no functions so it can cross the server/client boundary", () => {
    for (const view of PERSON_FIELD_VIEWS) {
      expect("compile" in view).toBe(false);
      for (const value of Object.values(view)) {
        expect(typeof value).not.toBe("function");
      }
    }
    expect(() => JSON.stringify(PERSON_FIELD_VIEWS)).not.toThrow();
  });
});

describe("relation-backed conditions (compliance program additions)", () => {
  it("hasApprovedStrike -> some/none APPROVED strike", () => {
    expect(personFieldWhere({ field: "hasApprovedStrike", op: "isTrue" }, ctx)).toEqual({
      incidentSubjectLinks: { some: { strikeDecision: "APPROVED" } },
    });
    expect(personFieldWhere({ field: "hasApprovedStrike", op: "isFalse" }, ctx)).toEqual({
      incidentSubjectLinks: { none: { strikeDecision: "APPROVED" } },
    });
  });

  it("hasOpenTechTicket -> some/none open-status ticket", () => {
    const open = ["SUBMITTED", "IN_PROGRESS", "AWAITING_REQUESTER", "AWAITING_YNHH"];
    expect(personFieldWhere({ field: "hasOpenTechTicket", op: "isTrue" }, ctx)).toEqual({
      techRequests: { some: { status: { in: open } } },
    });
    expect(personFieldWhere({ field: "hasOpenTechTicket", op: "isFalse" }, ctx)).toEqual({
      techRequests: { none: { status: { in: open } } },
    });
  });

  it("hasVerifiedCertificate -> some/none verified cert", () => {
    expect(personFieldWhere({ field: "hasVerifiedCertificate", op: "isTrue" }, ctx)).toEqual({
      hipaaCertificates: { some: { verifiedAt: { not: null } } },
    });
    expect(personFieldWhere({ field: "hasVerifiedCertificate", op: "isFalse" }, ctx)).toEqual({
      hipaaCertificates: { none: { verifiedAt: { not: null } } },
    });
  });

  it("addedToEhs -> direct boolean", () => {
    expect(personFieldWhere({ field: "addedToEhs", op: "isTrue" }, ctx)).toEqual({ addedToEhs: true });
    expect(personFieldWhere({ field: "addedToEhs", op: "isFalse" }, ctx)).toEqual({ addedToEhs: false });
  });

  it("completedVolunteerTraining -> active-term COMPLETE volunteer training", () => {
    expect(personFieldWhere({ field: "completedVolunteerTraining", op: "isTrue" }, ctx)).toEqual({
      trainings: { some: { termId: "term1", track: "VOLUNTEER", status: "COMPLETE" } },
    });
    expect(personFieldWhere({ field: "completedVolunteerTraining", op: "isFalse" }, ctx)).toEqual({
      trainings: { none: { termId: "term1", track: "VOLUNTEER", status: "COMPLETE" } },
    });
  });

  it("flaggedForOffboarding -> active-term offboard flag", () => {
    expect(personFieldWhere({ field: "flaggedForOffboarding", op: "isTrue" }, ctx)).toEqual({
      offboardFlags: { some: { termId: "term1" } },
    });
    expect(personFieldWhere({ field: "flaggedForOffboarding", op: "isFalse" }, ctx)).toEqual({
      offboardFlags: { none: { termId: "term1" } },
    });
  });

  // #69: with no active term, the negated (isFalse) branch used to compile to
  // `none: { termId: "" }`, which is TRUE for every Person row -> a campaign would
  // email the entire database. Both operators must match nobody.
  it("term-scoped fields match nobody when there is no active term", () => {
    const noTerm = { activeTermId: null, now: NOW, zone: ZONE };
    for (const field of ["completedVolunteerTraining", "flaggedForOffboarding"] as const) {
      expect(personFieldWhere({ field, op: "isTrue" }, noTerm)).toEqual({ id: { in: [] } });
      expect(personFieldWhere({ field, op: "isFalse" }, noTerm)).toEqual({ id: { in: [] } });
    }
  });

  // role and department are term-scoped too, but take eq/in rather than the
  // boolean operators above, so they need their own no-active-term assertions.
  // Both used to lean on `termId: ""` matching no membership by accident; these
  // pin the match-nobody guarantee to an explicit guard instead.
  it("role and department match nobody when there is no active term", () => {
    const noTerm = { activeTermId: null, now: NOW, zone: ZONE };
    expect(personFieldWhere({ field: "role", op: "eq", value: "DIRECTOR" }, noTerm)).toEqual({ id: { in: [] } });
    expect(personFieldWhere({ field: "role", op: "eq", value: "VOLUNTEER" }, noTerm)).toEqual({ id: { in: [] } });
    expect(personFieldWhere({ field: "department", op: "in", value: ["CARDIO", "PEDS"] }, noTerm)).toEqual({
      id: { in: [] },
    });
  });
});

// ---------------------------------------------------------------------------
// Term scoping
// ---------------------------------------------------------------------------

describe("term-scoped roster fields", () => {
  it("scopes role to the terms named on the condition, not the active term", () => {
    // The campaign this was built for: "everyone who volunteered in spring or
    // summer", asked while a LATER term is the active one.
    expect(
      personFieldWhere(
        { field: "role", op: "eq", value: "VOLUNTEER", terms: ["sp26", "su26"] },
        ctx,
      ),
    ).toEqual({
      memberships: { some: { termId: { in: ["sp26", "su26"] }, status: "ACTIVE", kind: "VOLUNTEER" } },
    });
  });

  it("keeps role and terms inside ONE membership clause", () => {
    // If the term scope were a separate condition, ALL-matching would let a
    // DIFFERENT membership row satisfy each half -- a director's SP26 stint
    // paired with this term's volunteer membership would wrongly match.
    const where = personFieldWhere(
      { field: "role", op: "eq", value: "VOLUNTEER", terms: ["sp26"] },
      ctx,
    ) as { memberships: { some: Record<string, unknown> } };
    expect(Object.keys(where.memberships.some).sort()).toEqual(["kind", "status", "termId"]);
  });

  it("falls back to the active term when no terms are named (legacy audiences)", () => {
    for (const terms of [undefined, [], [""], ["  "]]) {
      expect(personFieldWhere({ field: "role", op: "eq", value: "VOLUNTEER", terms }, ctx)).toEqual({
        memberships: { some: { termId: "term1", status: "ACTIVE", kind: "VOLUNTEER" } },
      });
    }
  });

  it("scopes department to named terms", () => {
    expect(
      personFieldWhere({ field: "department", op: "in", value: ["CARDIO"], terms: ["sp26", "su26"] }, ctx),
    ).toEqual({
      memberships: {
        some: { termId: { in: ["sp26", "su26"] }, status: "ACTIVE", department: { code: { in: ["CARDIO"] } } },
      },
    });
  });

  it("scopes the term-scoped boolean fields to named terms", () => {
    expect(
      personFieldWhere({ field: "completedVolunteerTraining", op: "isTrue", terms: ["sp26"] }, ctx),
    ).toEqual({ trainings: { some: { termId: "sp26", track: "VOLUNTEER", status: "COMPLETE" } } });
    expect(
      personFieldWhere({ field: "flaggedForOffboarding", op: "isTrue", terms: ["sp26"] }, ctx),
    ).toEqual({ offboardFlags: { some: { termId: "sp26" } } });
  });

  it("still matches nobody with no active term AND no named terms", () => {
    expect(
      personFieldWhere({ field: "role", op: "eq", value: "VOLUNTEER" }, { activeTermId: null, now: NOW, zone: ZONE }),
    ).toEqual({
      id: { in: [] },
    });
  });

  it("named terms work even with no active term", () => {
    expect(
      personFieldWhere(
        { field: "onRoster", op: "isTrue", terms: ["sp26"] },
        { activeTermId: null, now: NOW, zone: ZONE },
      ),
    ).toEqual({ memberships: { some: { termId: "sp26", status: "ACTIVE" } } });
  });
});

describe("onRoster", () => {
  it("matches any membership in scope regardless of track", () => {
    expect(personFieldWhere({ field: "onRoster", op: "isTrue", terms: ["sp26", "su26"] }, ctx)).toEqual({
      memberships: { some: { termId: { in: ["sp26", "su26"] }, status: "ACTIVE" } },
    });
  });

  it("uses `none` for the negative branch, which correctly includes non-members", () => {
    // Unlike role/department, "was never on the roster" genuinely does mean
    // people with no membership rows at all, so `none` is right here.
    expect(personFieldWhere({ field: "onRoster", op: "isFalse", terms: ["sp26"] }, ctx)).toEqual({
      memberships: { none: { termId: "sp26", status: "ACTIVE" } },
    });
  });
});

// ---------------------------------------------------------------------------
// Negation
// ---------------------------------------------------------------------------

describe("negated roster conditions", () => {
  it("requires roster membership AND excludes the attribute", () => {
    // The naive `{ memberships: { none: {...} } }` is true for every Person with
    // no memberships at all -- alumni, applicant-created rows, staff. On a send
    // list that is the whole database.
    expect(personFieldWhere({ field: "role", op: "notEq", value: "DIRECTOR", terms: ["sp26"] }, ctx)).toEqual({
      AND: [
        { memberships: { some: { termId: "sp26", status: "ACTIVE" } } },
        { memberships: { none: { termId: "sp26", status: "ACTIVE", kind: { in: ["DIRECTOR"] } } } },
      ],
    });
  });

  it("reads 'department is none of' as 'in no membership of those departments'", () => {
    // Not "in some membership that isn't one of these" -- a person in both
    // CARDIO and PEDS must NOT match "department is none of CARDIO".
    expect(personFieldWhere({ field: "department", op: "notIn", value: ["CARDIO"] }, ctx)).toEqual({
      AND: [
        { memberships: { some: { termId: "term1", status: "ACTIVE" } } },
        {
          memberships: {
            none: { termId: "term1", status: "ACTIVE", department: { code: { in: ["CARDIO"] } } },
          },
        },
      ],
    });
  });

  it("matches nobody when a negated roster condition has an empty value", () => {
    expect(personFieldWhere({ field: "role", op: "notIn", value: [] }, ctx)).toEqual({ id: { in: [] } });
    expect(personFieldWhere({ field: "department", op: "notIn", value: [] }, ctx)).toEqual({ id: { in: [] } });
  });
});

describe("negated scalar conditions", () => {
  it("keeps NULL rows on a nullable column", () => {
    expect(personFieldWhere({ field: "epicId", op: "notContains", value: "X" }, ctx)).toEqual({
      OR: [{ epicId: null }, { NOT: { epicId: { contains: "X", mode: "insensitive" } } }],
    });
    expect(personFieldWhere({ field: "yaleAffiliation", op: "notEq", value: "ysm_md" }, ctx)).toEqual({
      OR: [{ yaleAffiliation: null }, { yaleAffiliation: { not: "ysm_md" } }],
    });
  });

  it("matches nobody on a blank negative value (never everyone)", () => {
    for (const op of ["notEq", "notContains", "notIn"] as const) {
      expect(personFieldWhere({ field: "netId", op, value: "" }, ctx)).toEqual({ id: { in: [] } });
    }
    expect(personFieldWhere({ field: "status", op: "notIn", value: [] }, ctx)).toEqual({ id: { in: [] } });
  });

  it("supports multi-select on enum fields", () => {
    expect(personFieldWhere({ field: "status", op: "in", value: ["ACTIVE", "OFFBOARDED"] }, ctx)).toEqual({
      status: { in: ["ACTIVE", "OFFBOARDED"] },
    });
  });
});

describe("gradYear ordered comparison", () => {
  it("compiles before/after", () => {
    expect(personFieldWhere({ field: "gradYear", op: "lt", value: "2026" }, ctx)).toEqual({
      gradYear: { lt: "2026" },
    });
    expect(personFieldWhere({ field: "gradYear", op: "gt", value: "2024" }, ctx)).toEqual({
      gradYear: { gt: "2024" },
    });
  });

  it("matches nobody for a year that would sort wrong", () => {
    expect(personFieldWhere({ field: "gradYear", op: "lt", value: "'26" }, ctx)).toEqual({ id: { in: [] } });
  });
});

describe("appliedToCycle", () => {
  const appliedCtx = {
    activeTermId: "term1",
    now: NOW,
    zone: ZONE,
    appliedByCycle: new Map([
      ["fall26", new Set(["p1", "p2"])],
      ["spring27", new Set(["p2", "p3"])],
    ]),
  };

  it("unions the person ids across the selected cycles", () => {
    expect(
      personFieldWhere({ field: "appliedToCycle", op: "in", value: ["fall26", "spring27"] }, appliedCtx),
    ).toEqual({ id: { in: ["p1", "p2", "p3"] } });
  });

  it("negates to notIn, which correctly includes people who never applied", () => {
    expect(personFieldWhere({ field: "appliedToCycle", op: "notIn", value: ["fall26"] }, appliedCtx)).toEqual({
      id: { notIn: ["p1", "p2"] },
    });
  });

  it("matches nobody when no cycle is selected", () => {
    expect(personFieldWhere({ field: "appliedToCycle", op: "in", value: [] }, appliedCtx)).toEqual({
      id: { in: [] },
    });
    expect(personFieldWhere({ field: "appliedToCycle", op: "notIn", value: [] }, appliedCtx)).toEqual({
      id: { in: [] },
    });
  });

  it("throws when resolveAudience did not precompute the map", () => {
    expect(() =>
      personFieldWhere({ field: "appliedToCycle", op: "in", value: ["fall26"] }, ctx),
    ).toThrow(/precomputed applicant map/);
  });
});

describe("personFieldWhere operator gating", () => {
  it("matches nobody for an operator the field does not declare", () => {
    // Only reachable from a hand-edited or stale stored audience; compiling it
    // would either throw deep in a helper or fall through to a default branch.
    expect(personFieldWhere({ field: "licensedRN", op: "contains", value: "x" }, ctx)).toEqual({
      id: { in: [] },
    });
    expect(personFieldWhere({ field: "name", op: "isTrue" }, ctx)).toEqual({ id: { in: [] } });
  });
});
