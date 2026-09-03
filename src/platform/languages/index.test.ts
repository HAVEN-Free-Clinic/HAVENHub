import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  LANGUAGES,
  isLanguageCode,
  languageLabel,
  needsLanguageReview,
  listLanguageReviewQueue,
  recordLanguageAssessment,
  claimLanguage,
  verifiedLanguagesByPerson,
  personIdsVerifiedIn,
  languageCodeFromAnswer,
  LanguageValidationError,
} from "./index";

const ACTOR = "lang-actor";

async function actor() {
  return prisma.person.create({ data: { id: ACTOR, name: "Interpreter Lead" } });
}

async function person(name: string, status: "ACTIVE" | "OFFBOARDED" = "ACTIVE") {
  return prisma.person.create({ data: { name, status } });
}

beforeEach(resetDb);

describe("language catalog", () => {
  it("accepts a known code and rejects an unknown one", () => {
    expect(isLanguageCode("es")).toBe(true);
    expect(isLanguageCode("klingon")).toBe(false);
  });

  it("labels a known code, and falls back to the raw code for a retired one", () => {
    expect(languageLabel("ht")).toBe("Haitian Creole");
    expect(languageLabel("xx")).toBe("xx");
  });

  it("has no duplicate codes", () => {
    const codes = LANGUAGES.map((l) => l.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe("claimLanguage", () => {
  it("records a self-reported claim that is NOT verified", async () => {
    const p = await person("Claimant");
    await claimLanguage(p.id, "es");

    const row = await prisma.personLanguage.findUniqueOrThrow({
      where: { personId_language: { personId: p.id, language: "es" } },
    });
    expect(row.selfReported).toBe(true);
    expect(row.verified).toBe(false);
    expect(row.verifiedAt).toBeNull();
  });

  // Re-stating a claim at a later intake must not undo an assessment already
  // made, or every renewal would send verified people back through review.
  it("does not clobber an existing assessment", async () => {
    await actor();
    const p = await person("Assessed");
    await recordLanguageAssessment(ACTOR, { personId: p.id, language: "es", verified: true });

    await claimLanguage(p.id, "es");

    const row = await prisma.personLanguage.findUniqueOrThrow({
      where: { personId_language: { personId: p.id, language: "es" } },
    });
    expect(row.verified).toBe(true);
    expect(row.verifiedAt).not.toBeNull();
    expect(row.selfReported).toBe(true);
  });

  it("rejects an unknown language code", async () => {
    const p = await person("Bad Code");
    await expect(claimLanguage(p.id, "klingon")).rejects.toBeInstanceOf(LanguageValidationError);
  });
});

describe("review queue", () => {
  it("queues an unassessed claim and removes it once assessed either way", async () => {
    await actor();
    const yes = await person("Will Pass");
    const no = await person("Will Fail");
    await claimLanguage(yes.id, "es");
    await claimLanguage(no.id, "ht");

    expect((await listLanguageReviewQueue()).map((r) => r.personId).sort()).toEqual(
      [yes.id, no.id].sort(),
    );

    await recordLanguageAssessment(ACTOR, { personId: yes.id, language: "es", verified: true });
    await recordLanguageAssessment(ACTOR, { personId: no.id, language: "ht", verified: false });

    // A "no" is still an assessment: it settles the question rather than
    // leaving the person queued to be re-reviewed forever.
    expect(await listLanguageReviewQueue()).toEqual([]);
  });

  it("excludes offboarded people", async () => {
    const gone = await person("Departed", "OFFBOARDED");
    await claimLanguage(gone.id, "es");
    expect(await listLanguageReviewQueue()).toEqual([]);
  });

  it("queues each claimed language separately", async () => {
    const p = await person("Polyglot");
    await claimLanguage(p.id, "es");
    await claimLanguage(p.id, "pt");

    const queue = await listLanguageReviewQueue();
    expect(queue).toHaveLength(2);
    expect(queue.map((r) => r.language).sort()).toEqual(["es", "pt"]);
  });

  it("needsLanguageReview keys on verifiedAt, not on the outcome", () => {
    expect(needsLanguageReview({ verifiedAt: null })).toBe(true);
    expect(needsLanguageReview({ verifiedAt: new Date() })).toBe(false);
  });
});

describe("the language review queue", () => {
  it("surfaces the current score on the queue row", async () => {
    await actor();
    const p = await person("Already Scored");
    await recordLanguageAssessment(ACTOR, {
      personId: p.id,
      language: "es",
      verified: true,
      score: 3,
    });
    // Re-claiming puts them back in view without disturbing the score.
    await prisma.personLanguage.update({
      where: { personId_language: { personId: p.id, language: "es" } },
      data: { verifiedAt: null },
    });

    const [row] = await listLanguageReviewQueue();
    expect(row.score).toBe(3);
  });

  // The queue used to split on active-term INTP membership: interpreting members
  // were scored and everyone else got a bare yes/no. That is exactly why a
  // department willing to staff a conversational speaker had no number to
  // compare against its own bar.
  it("returns one flat queue regardless of interpreting membership", async () => {
    const outsider = await person("Outside Interpreting");
    await claimLanguage(outsider.id, "es");

    const rows = await listLanguageReviewQueue();

    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty("isIntp");
    expect(rows[0].score).toBeNull();
  });
});

describe("recordLanguageAssessment", () => {
  it("stamps the assessor and timestamp, and audits", async () => {
    await actor();
    const p = await person("Assessed");
    await recordLanguageAssessment(ACTOR, { personId: p.id, language: "es", verified: true });

    const row = await prisma.personLanguage.findUniqueOrThrow({
      where: { personId_language: { personId: p.id, language: "es" } },
    });
    expect(row.verifiedById).toBe(ACTOR);
    expect(row.verifiedAt).not.toBeNull();

    const audit = await prisma.auditLog.findFirst({ where: { action: "person.language_assess" } });
    expect(audit).not.toBeNull();
  });

  it("can reverse an earlier assessment", async () => {
    await actor();
    const p = await person("Reassessed");
    await recordLanguageAssessment(ACTOR, { personId: p.id, language: "es", verified: true });
    await recordLanguageAssessment(ACTOR, { personId: p.id, language: "es", verified: false });

    const row = await prisma.personLanguage.findUniqueOrThrow({
      where: { personId_language: { personId: p.id, language: "es" } },
    });
    expect(row.verified).toBe(false);
    // Still assessed, so still out of the queue.
    expect(row.verifiedAt).not.toBeNull();
  });

  it("rejects an unknown language code", async () => {
    await actor();
    const p = await person("Bad");
    await expect(
      recordLanguageAssessment(ACTOR, { personId: p.id, language: "klingon", verified: true }),
    ).rejects.toBeInstanceOf(LanguageValidationError);
  });

  it("emails the member when their language is confirmed", async () => {
    await actor();
    const p = await prisma.person.create({
      data: { name: "Ana Reyes", status: "ACTIVE", contactEmail: "ana@yale.edu" },
    });
    await recordLanguageAssessment(ACTOR, { personId: p.id, language: "es", verified: true });

    const log = await prisma.emailLog.findFirstOrThrow({
      where: { template: "volunteers.language_assessed", personId: p.id },
    });
    expect(log.html).toContain("Spanish");
    expect(log.html).toContain("confirmed");
  });

  // The outcome that would otherwise be silent. A claim assessed and NOT
  // confirmed leaves the queue with nothing said, so the member goes on
  // believing they are on record as a provider when they are not.
  it("emails the member when their language is NOT confirmed", async () => {
    await actor();
    const p = await prisma.person.create({
      data: { name: "Ben Ito", status: "ACTIVE", contactEmail: "ben@yale.edu" },
    });
    await recordLanguageAssessment(ACTOR, { personId: p.id, language: "ht", verified: false });

    const log = await prisma.emailLog.findFirstOrThrow({
      where: { template: "volunteers.language_assessed", personId: p.id },
    });
    expect(log.html).toContain("Haitian Creole");
    expect(log.html).toContain("has not confirmed it");
    // Reassurance matters here: this is not a disciplinary outcome.
    expect(log.html).toContain("not a mark against you");
  });

  // The assessment is already committed by the time the email is attempted, so
  // a delivery problem must never surface as a failed assessment.
  it("still records the assessment when the member has no email", async () => {
    await actor();
    const p = await prisma.person.create({ data: { name: "No Email", status: "ACTIVE" } });
    await expect(
      recordLanguageAssessment(ACTOR, { personId: p.id, language: "es", verified: true }),
    ).resolves.toBeUndefined();

    const row = await prisma.personLanguage.findUniqueOrThrow({
      where: { personId_language: { personId: p.id, language: "es" } },
    });
    expect(row.verified).toBe(true);
  });
});

describe("languageCodeFromAnswer", () => {
  // Applicants pick LABELS ("Haitian Creole"), everything downstream keys on
  // codes. Accepting a code too means a re-submitted draft that already stored
  // codes still resolves.
  it("maps a label, case-insensitively, and passes a code through", () => {
    expect(languageCodeFromAnswer("Haitian Creole")).toBe("ht");
    expect(languageCodeFromAnswer("  spanish ")).toBe("es");
    expect(languageCodeFromAnswer("es")).toBe("es");
  });

  it("returns null for anything unrecognized rather than inventing a language", () => {
    expect(languageCodeFromAnswer("Klingon")).toBeNull();
    expect(languageCodeFromAnswer("")).toBeNull();
  });
});

describe("verifiedLanguagesByPerson", () => {
  // The load-bearing rule for everything downstream: scheduling, capacity
  // counts, badges, and the service record act on VERIFIED capability only. A
  // self-reported claim leaking through would let a director schedule someone
  // as an interpreter on the strength of a checkbox they ticked themselves.
  it("returns verified languages only, never self-reported claims", async () => {
    await actor();
    const p = await person("Mixed");
    await claimLanguage(p.id, "pt"); // claimed, never assessed
    await recordLanguageAssessment(ACTOR, { personId: p.id, language: "es", verified: true });
    await recordLanguageAssessment(ACTOR, { personId: p.id, language: "ht", verified: false });

    const map = await verifiedLanguagesByPerson([p.id]);
    expect(map.get(p.id)).toEqual(["es"]);
  });

  it("omits a person with nothing verified rather than returning an empty entry", async () => {
    const p = await person("Nothing");
    await claimLanguage(p.id, "es");
    expect((await verifiedLanguagesByPerson([p.id])).has(p.id)).toBe(false);
  });

  it("is a no-op on an empty id list", async () => {
    expect((await verifiedLanguagesByPerson([])).size).toBe(0);
  });
});

describe("personIdsVerifiedIn", () => {
  it("finds only people verified in that language", async () => {
    await actor();
    const es = await person("Spanish Speaker");
    const ht = await person("Creole Speaker");
    const claimed = await person("Only Claimed");
    await recordLanguageAssessment(ACTOR, { personId: es.id, language: "es", verified: true });
    await recordLanguageAssessment(ACTOR, { personId: ht.id, language: "ht", verified: true });
    await claimLanguage(claimed.id, "es");

    const ids = await personIdsVerifiedIn("es");
    expect(ids.has(es.id)).toBe(true);
    expect(ids.has(ht.id)).toBe(false);
    expect(ids.has(claimed.id)).toBe(false);
  });
});

describe("the proficiency score", () => {
  // Spanish-only and INTERNAL: it drives the INTP interpreting bar and is
  // deliberately not shown to the volunteer it describes.
  it("records a 1-5 score alongside the assessment", async () => {
    await actor();
    const p = await person("Scored");
    await recordLanguageAssessment(ACTOR, {
      personId: p.id,
      language: "es",
      verified: true,
      score: 4,
    });

    const row = await prisma.personLanguage.findUniqueOrThrow({
      where: { personId_language: { personId: p.id, language: "es" } },
    });
    expect(row.score).toBe(4);
  });

  // The bug: the Not-verified button, and every verify from the general queue,
  // carry no score field. Writing `score ?? null` unconditionally then erased an
  // assessment INTP had already recorded.
  it("leaves an existing score alone when the caller does not mention one", async () => {
    await actor();
    const p = await person("Scored Then Reassessed");
    await recordLanguageAssessment(ACTOR, {
      personId: p.id,
      language: "es",
      verified: true,
      score: 4,
    });

    await recordLanguageAssessment(ACTOR, { personId: p.id, language: "es", verified: false });

    const row = await prisma.personLanguage.findUniqueOrThrow({
      where: { personId_language: { personId: p.id, language: "es" } },
    });
    expect(row.verified).toBe(false);
    expect(row.score).toBe(4);
  });

  it("clears the score when the caller explicitly passes null (the N/A option)", async () => {
    await actor();
    const p = await person("Score Cleared");
    await recordLanguageAssessment(ACTOR, {
      personId: p.id,
      language: "es",
      verified: true,
      score: 4,
    });
    await recordLanguageAssessment(ACTOR, {
      personId: p.id,
      language: "es",
      verified: true,
      score: null,
    });

    const row = await prisma.personLanguage.findUniqueOrThrow({
      where: { personId_language: { personId: p.id, language: "es" } },
    });
    expect(row.score).toBeNull();
  });

  it("rejects a score outside 1-5 rather than storing it", async () => {
    await actor();
    const p = await person("Bad Score");
    await expect(
      recordLanguageAssessment(ACTOR, { personId: p.id, language: "es", verified: true, score: 9 }),
    ).rejects.toBeInstanceOf(LanguageValidationError);
  });

  it("refuses a score for a language that does not carry one", async () => {
    await actor();
    const p = await person("Wrong Language");
    await expect(
      recordLanguageAssessment(ACTOR, { personId: p.id, language: "pt", verified: true, score: 4 }),
    ).rejects.toBeInstanceOf(LanguageValidationError);
  });

  it("records the score in the audit trail", async () => {
    await actor();
    const p = await person("Audited");
    await recordLanguageAssessment(ACTOR, {
      personId: p.id,
      language: "es",
      verified: true,
      score: 3,
    });

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: "person.language_assess", entityId: p.id },
      orderBy: { createdAt: "desc" },
    });
    expect((entry.after as Record<string, unknown>).score).toBe(3);
  });
});

describe("claimLanguage created-ness", () => {
  // Drives whether the interpreting department is told. A returning member
  // re-stating a language already on their record is not new work for a
  // reviewer, and notifying on it re-mailed every reviewer at each renewal.
  it("reports a first claim as created", async () => {
    const p = await person("First Claim");
    expect(await claimLanguage(p.id, "es")).toEqual({ created: true });
  });

  it("reports a repeat claim as not created", async () => {
    const p = await person("Repeat Claim");
    await claimLanguage(p.id, "es");
    expect(await claimLanguage(p.id, "es")).toEqual({ created: false });
  });

  it("reports a second, different language as created", async () => {
    const p = await person("Two Languages");
    await claimLanguage(p.id, "es");
    expect(await claimLanguage(p.id, "pt")).toEqual({ created: true });
  });
});
