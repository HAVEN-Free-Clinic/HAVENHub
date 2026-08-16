import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { LANGUAGE_QUESTION, LANGUAGES } from "@/platform/languages";
import { backfillLanguageQuestion, languageQuestionIsCorrect, pickTargetSection } from "./language-question";
import { publishCycle } from "./cycles";

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

async function seedTermAndPerson() {
  const person = await prisma.person.create({ data: { name: "Lead", status: "ACTIVE" } });
  const term = await prisma.term.create({
    data: { code: "FA26", name: "Fall 2026", startDate: new Date("2026-09-01"), endDate: new Date("2026-12-15") },
  });
  return { person, term };
}

/**
 * A cycle built the way they were BEFORE the standard question existed: identity
 * fields, and a Languages section holding the free-text pair. Deliberately
 * hand-built rather than created through createCycle, which now seeds the
 * question -- there would be nothing to back-fill.
 */
async function seedLegacyCycle(opts: { slug: string; status?: "DRAFT" | "OPEN"; withLegacyFields?: boolean } ) {
  const { person, term } = await seedTermAndPerson();
  const cycle = await prisma.recruitmentCycle.create({
    data: {
      track: "VOLUNTEER", termId: term.id, title: `Cycle ${opts.slug}`, publicSlug: opts.slug,
      departments: ["SRHD"], acceptsRenewals: false, createdById: person.id,
      status: opts.status ?? "DRAFT",
      sections: {
        create: [
          { title: "Your information", order: 0, appliesTo: "BOTH" },
          { title: "Languages", order: 1, appliesTo: "NEW" },
        ],
      },
    },
    include: { sections: { orderBy: { order: "asc" } } },
  });
  const [identity, languages] = cycle.sections;
  await prisma.formField.createMany({
    data: [
      { sectionId: identity.id, cycleId: cycle.id, key: "first_name", label: "First name", type: "SHORT_TEXT", required: true, order: 0 },
      { sectionId: identity.id, cycleId: cycle.id, key: "last_name", label: "Last name", type: "SHORT_TEXT", required: true, order: 1 },
      { sectionId: identity.id, cycleId: cycle.id, key: "email", label: "Yale email", type: "EMAIL", required: true, order: 2 },
      ...(opts.withLegacyFields === false ? [] : [
        { sectionId: languages.id, cycleId: cycle.id, key: "other_languages", label: "Other languages?", type: "SINGLE_SELECT" as const, required: false, order: 0 },
        { sectionId: languages.id, cycleId: cycle.id, key: "other_languages_detail", label: "Which?", type: "SHORT_TEXT" as const, required: false, order: 1 },
      ]),
    ],
  });
  return { cycle, identity, languages, person };
}

const fieldsFor = (cycleId: string) => prisma.formField.findMany({ where: { cycleId } });

describe("backfillLanguageQuestion", () => {
  it("adds the question to a legacy DRAFT cycle, in the section that held the free-text pair", async () => {
    const { cycle, languages } = await seedLegacyCycle({ slug: "legacy-1" });

    const reports = await backfillLanguageQuestion({ dryRun: false });

    expect(reports).toHaveLength(1);
    expect(reports[0].outcome).toBe("added");
    expect(reports[0].sectionTitle).toBe("Languages");

    const added = (await fieldsFor(cycle.id)).find((f) => f.key === LANGUAGE_QUESTION.key)!;
    expect(added.sectionId).toBe(languages.id);
    expect(added.type).toBe("MULTI_SELECT");
    // It takes the place the legacy pair occupied rather than landing at the
    // end, so the applicant's reading order is unchanged.
    expect(added.order).toBe(0);
  });

  it("removes the unmatchable free-text pair it replaces", async () => {
    const { cycle } = await seedLegacyCycle({ slug: "legacy-2" });

    await backfillLanguageQuestion({ dryRun: false });

    const keys = (await fieldsFor(cycle.id)).map((f) => f.key);
    expect(keys).not.toContain("other_languages");
    expect(keys).not.toContain("other_languages_detail");
  });

  it("dry run reports exactly what it would do and writes nothing", async () => {
    const { cycle } = await seedLegacyCycle({ slug: "legacy-3" });
    const before = (await fieldsFor(cycle.id)).map((f) => f.key).sort();

    const reports = await backfillLanguageQuestion({ dryRun: true });

    expect(reports[0].outcome).toBe("added");
    expect(reports[0].legacyRemoved.sort()).toEqual(["other_languages", "other_languages_detail"]);
    expect((await fieldsFor(cycle.id)).map((f) => f.key).sort()).toEqual(before);
  });

  it("is idempotent: a second run reports already-correct and changes nothing", async () => {
    const { cycle } = await seedLegacyCycle({ slug: "legacy-4" });
    await backfillLanguageQuestion({ dryRun: false });
    const after1 = await fieldsFor(cycle.id);

    const reports = await backfillLanguageQuestion({ dryRun: false });

    expect(reports[0].outcome).toBe("already-correct");
    const after2 = await fieldsFor(cycle.id);
    expect(after2.map((f) => f.id).sort()).toEqual(after1.map((f) => f.id).sort());
  });

  it("repairs a question that exists with label options instead of language codes", async () => {
    const { cycle, languages } = await seedLegacyCycle({ slug: "legacy-5", withLegacyFields: false });
    // The exact shape that silently breaks the chain: the applicant answers
    // "Spanish", which is a label, and nothing maps it to a code.
    await prisma.formField.create({
      data: {
        sectionId: languages.id, cycleId: cycle.id, key: LANGUAGE_QUESTION.key,
        label: "Languages", type: "MULTI_SELECT", required: false, order: 0,
        options: [{ value: "Spanish", label: "Spanish" }],
      },
    });

    const reports = await backfillLanguageQuestion({ dryRun: false });

    expect(reports[0].outcome).toBe("repaired");
    const repaired = (await fieldsFor(cycle.id)).find((f) => f.key === LANGUAGE_QUESTION.key)!;
    expect(languageQuestionIsCorrect({ type: repaired.type, options: repaired.options })).toBe(true);
  });

  it("leaves a repaired question where the cycle's author put it", async () => {
    const { cycle, identity } = await seedLegacyCycle({ slug: "legacy-6", withLegacyFields: false });
    await prisma.formField.create({
      data: {
        sectionId: identity.id, cycleId: cycle.id, key: LANGUAGE_QUESTION.key,
        label: "Languages", type: "SHORT_TEXT", required: false, order: 9,
      },
    });

    await backfillLanguageQuestion({ dryRun: false });

    const repaired = (await fieldsFor(cycle.id)).find((f) => f.key === LANGUAGE_QUESTION.key)!;
    expect(repaired.sectionId).toBe(identity.id);
    expect(repaired.order).toBe(9);
  });

  it("does not touch cycles that are already OPEN", async () => {
    const { cycle } = await seedLegacyCycle({ slug: "legacy-7", status: "OPEN" });

    const reports = await backfillLanguageQuestion({ dryRun: false });

    expect(reports).toEqual([]);
    const keys = (await fieldsFor(cycle.id)).map((f) => f.key);
    expect(keys).not.toContain(LANGUAGE_QUESTION.key);
    // The applicants part-way through this cycle keep the form they started.
    expect(keys).toContain("other_languages");
  });

  // The whole point of the backfill: a legacy draft cannot be published today,
  // and can be afterwards. Without this the backfill could "succeed" while
  // still writing a shape publishCycle rejects.
  it("unblocks publish for a legacy draft that publishCycle would otherwise refuse", async () => {
    const { cycle, person } = await seedLegacyCycle({ slug: "legacy-8" });

    await expect(publishCycle(cycle.id, person.id)).rejects.toThrow(/language question/i);

    await backfillLanguageQuestion({ dryRun: false });

    const published = await publishCycle(cycle.id, person.id);
    expect(published.status).toBe("OPEN");
  });
});

describe("languageQuestionIsCorrect", () => {
  it("accepts the canonical question", () => {
    expect(languageQuestionIsCorrect({ type: "MULTI_SELECT", options: [...LANGUAGE_QUESTION.options] })).toBe(true);
  });

  it("rejects the wrong type, label-valued options, and a truncated catalog", () => {
    expect(languageQuestionIsCorrect({ type: "SHORT_TEXT", options: [...LANGUAGE_QUESTION.options] })).toBe(false);
    expect(languageQuestionIsCorrect({ type: "MULTI_SELECT", options: [{ value: "Spanish", label: "Spanish" }] })).toBe(false);
    // A cycle offering only some of the catalog is not the standard question:
    // an applicant who speaks a missing language has no way to say so.
    expect(
      languageQuestionIsCorrect({ type: "MULTI_SELECT", options: LANGUAGES.slice(0, 3).map((l) => ({ value: l.code, label: l.label })) }),
    ).toBe(false);
  });
});

describe("pickTargetSection", () => {
  const section = (over: Partial<{ id: string; title: string; purpose: string; order: number; fields: Array<{ id: string; key: string; type: string; order: number; options: unknown; required: boolean }> }>) => ({
    id: "s", title: "S", purpose: "APPLICATION", order: 0, fields: [], ...over,
  });
  const field = (key: string) => ({ id: key, key, type: "SHORT_TEXT", order: 0, options: null, required: false });

  it("never targets a non-application section", () => {
    const cycle = { id: "c", title: "C", sections: [section({ id: "quiz", purpose: "QUIZ", fields: [field("first_name")] })] };
    expect(pickTargetSection(cycle)).toBeNull();
  });

  it("prefers the legacy section, then a Languages section, then identity", () => {
    const legacy = section({ id: "legacy", title: "Misc", order: 2, fields: [field("other_languages")] });
    const languages = section({ id: "lang", title: "Languages", order: 1 });
    const identity = section({ id: "id", title: "Your information", order: 0, fields: [field("first_name")] });

    expect(pickTargetSection({ id: "c", title: "C", sections: [identity, languages, legacy] })?.id).toBe("legacy");
    expect(pickTargetSection({ id: "c", title: "C", sections: [identity, languages] })?.id).toBe("lang");
    expect(pickTargetSection({ id: "c", title: "C", sections: [identity] })?.id).toBe("id");
  });
});
