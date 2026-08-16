/**
 * Backfill: put the standard language question into cycles built before it
 * existed, and repair it where it exists in the wrong shape.
 *
 * An answer is only useful if it can be mapped back to a language code, which
 * is what carries it from the application into the interpreting department's
 * verification queue at promotion. A free-text answer, or a select whose option
 * values are labels rather than codes, breaks that chain silently: the applicant
 * answers, and nothing downstream happens. publishCycle enforces the same three
 * properties this backfill writes.
 *
 * The question itself is defined once, in @/platform/languages.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/platform/db";
import { LANGUAGES, LANGUAGE_QUESTION, LEGACY_LANGUAGE_FIELD_KEYS } from "@/platform/languages";

/**
 * A full client, not a transaction client: this opens its own per-cycle
 * transaction, so it cannot be handed one.
 */
type Db = PrismaClient;

export type CycleBackfillOutcome =
  | "added"
  | "repaired"
  | "already-correct";

export type CycleBackfillReport = {
  cycleId: string;
  title: string;
  outcome: CycleBackfillOutcome;
  /** Section the question sits in afterwards. */
  sectionTitle: string;
  /** Legacy free-text keys removed from this cycle. */
  legacyRemoved: string[];
  /** Set when legacy fields were LEFT in place despite the cycle being DRAFT. */
  legacyKeptReason?: string;
};

/** A cycle shaped the way the backfill needs to read it. */
type CycleForBackfill = {
  id: string;
  title: string;
  sections: Array<{
    id: string;
    title: string;
    purpose: string;
    order: number;
    fields: Array<{ id: string; key: string; type: string; order: number; options: unknown; required: boolean }>;
  }>;
};

/**
 * Decide which section the question belongs in, for a cycle that has no
 * standard question yet.
 *
 * Preference order, most to least specific:
 *   1. the section holding the legacy free-text fields, so the question lands
 *      where this cycle's author already put language questions;
 *   2. a section titled "Languages";
 *   3. the identity section (the one with first_name), which is where the
 *      minimal cycle seed puts it;
 *   4. the first application section, so the question is never dropped.
 *
 * QUIZ and other non-application sections are never eligible: a question in a
 * quiz section is not part of the application and would never be answered.
 */
export function pickTargetSection(cycle: CycleForBackfill) {
  const applicationSections = cycle.sections
    .filter((s) => s.purpose === "APPLICATION")
    .sort((a, b) => a.order - b.order);
  if (applicationSections.length === 0) return null;

  const withLegacy = applicationSections.find((s) =>
    s.fields.some((f) => LEGACY_LANGUAGE_FIELD_KEYS.includes(f.key)),
  );
  if (withLegacy) return withLegacy;

  const titled = applicationSections.find((s) => s.title.trim().toLowerCase() === "languages");
  if (titled) return titled;

  const identity = applicationSections.find((s) => s.fields.some((f) => f.key === "first_name"));
  if (identity) return identity;

  return applicationSections[0];
}

/**
 * True when an existing standard question is already correct.
 *
 * Deliberately the same three properties publishCycle checks, so "the backfill
 * says this cycle is fine" and "publish accepts this cycle" cannot disagree:
 * right type, and every option value a resolvable language code.
 */
export function languageQuestionIsCorrect(field: { type: string; options: unknown }): boolean {
  if (field.type !== "MULTI_SELECT") return false;
  if (!Array.isArray(field.options)) return false;
  const expected = new Set<string>(LANGUAGES.map((l) => l.code));
  if (field.options.length !== expected.size) return false;
  return field.options.every(
    (o) =>
      typeof o === "object" &&
      o !== null &&
      typeof (o as { value?: unknown }).value === "string" &&
      expected.has((o as { value: string }).value),
  );
}

/**
 * Add or repair the standard language question on every DRAFT cycle.
 *
 * DRAFT only, and that is a correctness boundary rather than caution: submitting
 * requires status OPEN, and reopen goes CLOSED -> OPEN (never back to DRAFT), so
 * a DRAFT cycle provably has no submissions and no answers can be orphaned by
 * removing the legacy fields. Adding a question to a cycle that is already open
 * would also change the form under applicants mid-cycle, and leave everyone who
 * already applied with no answer to it -- that is an ops decision, not a backfill.
 *
 * Idempotent: a cycle that already has a correct question is reported and left
 * alone, so this is safe to re-run.
 */
export async function backfillLanguageQuestion(
  opts: { dryRun: boolean } = { dryRun: true },
  client: Db = prisma,
): Promise<CycleBackfillReport[]> {
  const cycles = await client.recruitmentCycle.findMany({
    where: { status: "DRAFT" },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      title: true,
      sections: {
        orderBy: { order: "asc" },
        select: {
          id: true,
          title: true,
          purpose: true,
          order: true,
          fields: {
            orderBy: { order: "asc" },
            select: { id: true, key: true, type: true, order: true, options: true, required: true },
          },
        },
      },
    },
  });

  const reports: CycleBackfillReport[] = [];

  for (const cycle of cycles) {
    // The DRAFT invariant above says this is always 0. Checked anyway, because
    // the cost of being wrong is deleting fields that answers point at, and the
    // cost of checking is one count per draft cycle.
    const submissionCount = await client.application.count({ where: { cycleId: cycle.id } });
    const canRemoveLegacy = submissionCount === 0;

    const existing = cycle.sections.flatMap((s) => s.fields).find((f) => f.key === LANGUAGE_QUESTION.key);
    const targetSection = existing
      ? cycle.sections.find((s) => s.fields.some((f) => f.id === existing.id))!
      : pickTargetSection(cycle);

    if (!targetSection) {
      // No application section at all (a cycle with only a quiz, say). Nowhere
      // correct to put the question, and inventing a section here would be a
      // surprising structural change. Skip it; publishCycle will still refuse.
      continue;
    }

    const legacyFields = cycle.sections
      .flatMap((s) => s.fields)
      .filter((f) => LEGACY_LANGUAGE_FIELD_KEYS.includes(f.key));

    let outcome: CycleBackfillOutcome;
    if (!existing) {
      outcome = "added";
    } else if (languageQuestionIsCorrect(existing)) {
      outcome = "already-correct";
    } else {
      outcome = "repaired";
    }

    const legacyRemoved = canRemoveLegacy ? legacyFields.map((f) => f.key) : [];

    if (!opts.dryRun) {
      await client.$transaction(async (tx: Prisma.TransactionClient) => {
        if (outcome === "added") {
          // Sit where the legacy fields were when there were any, so the
          // question keeps its place in the applicant's reading order rather
          // than appearing at the end of an unrelated section.
          const order =
            legacyFields.length > 0
              ? Math.min(...legacyFields.map((f) => f.order))
              : Math.max(-1, ...targetSection.fields.map((f) => f.order)) + 1;
          await tx.formField.create({
            data: {
              sectionId: targetSection.id,
              cycleId: cycle.id,
              key: LANGUAGE_QUESTION.key,
              label: LANGUAGE_QUESTION.label,
              helpText: LANGUAGE_QUESTION.helpText,
              type: LANGUAGE_QUESTION.type,
              required: LANGUAGE_QUESTION.required,
              options: LANGUAGE_QUESTION.options as unknown as Prisma.InputJsonValue,
              order,
            },
          });
        } else if (outcome === "repaired") {
          // Type/options/label only. `order` and `sectionId` are left alone:
          // whoever edited this cycle chose where the question sits, and the
          // lock is on the question's shape, not on its position.
          await tx.formField.update({
            where: { id: existing!.id },
            data: {
              label: LANGUAGE_QUESTION.label,
              helpText: LANGUAGE_QUESTION.helpText,
              type: LANGUAGE_QUESTION.type,
              required: LANGUAGE_QUESTION.required,
              options: LANGUAGE_QUESTION.options as unknown as Prisma.InputJsonValue,
            },
          });
        }

        if (legacyRemoved.length > 0) {
          await tx.formField.deleteMany({ where: { id: { in: legacyFields.map((f) => f.id) } } });
        }
      });
    }

    reports.push({
      cycleId: cycle.id,
      title: cycle.title,
      outcome,
      sectionTitle: targetSection.title,
      legacyRemoved,
      ...(legacyFields.length > 0 && !canRemoveLegacy
        ? { legacyKeptReason: `${submissionCount} application(s) exist on this DRAFT cycle` }
        : {}),
    });
  }

  return reports;
}
