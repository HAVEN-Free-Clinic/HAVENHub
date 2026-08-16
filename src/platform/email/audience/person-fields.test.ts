import { describe, expect, it } from "vitest";
import type { ComplianceStatus } from "@/platform/compliance/rules";
import { PERSON_FIELDS, PERSON_FIELD_VIEWS, personFieldWhere, parseTextList } from "./person-fields";

const ctx = { activeTermId: "term1" };

const complianceCtx = {
  activeTermId: "term1",
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
      "status", "role", "department", "complianceStatus", "hasEpicId",
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

describe("parseTextList", () => {
  it("splits on commas and newlines, trims, drops blanks", () => {
    expect(parseTextList("a, b\nc ,, \n d")).toEqual(["a", "b", "c", "d"]);
  });
  it("passes through an array, trimming and dropping blanks", () => {
    expect(parseTextList(["a", " b ", ""])).toEqual(["a", "b"]);
  });
  it("returns [] for undefined", () => {
    expect(parseTextList(undefined)).toEqual([]);
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
    const noTerm = { activeTermId: null };
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
    const noTerm = { activeTermId: null };
    expect(personFieldWhere({ field: "role", op: "eq", value: "DIRECTOR" }, noTerm)).toEqual({ id: { in: [] } });
    expect(personFieldWhere({ field: "role", op: "eq", value: "VOLUNTEER" }, noTerm)).toEqual({ id: { in: [] } });
    expect(personFieldWhere({ field: "department", op: "in", value: ["CARDIO", "PEDS"] }, noTerm)).toEqual({
      id: { in: [] },
    });
  });
});
