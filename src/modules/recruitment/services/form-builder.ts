import type { ApplicantScope, FieldType, FormField, FormSection } from "@prisma/client";
import { prisma } from "@/platform/db";
import { uniqueKey } from "../engine/field-key";
import { parseFieldCondition } from "../engine/field-visibility";
import { isDisplayOnlyNotice } from "../engine/notice";
import { LANGUAGES_FIELD_KEY } from "@/platform/languages";

/**
 * Field keys publishCycle refuses to publish without, so they must not be
 * deletable once a cycle IS published.
 *
 * publishCycle checks these once, at the DRAFT -> OPEN transition, and nothing
 * re-checked afterwards while assertCycleEditable only ever blocked ARCHIVED.
 * A live cycle could therefore lose the very fields that make a submission
 * possible: applicants walked a form that never asked their name or email, and
 * submitPublicApplication threw on the empty identity rather than failing any
 * single field -- surfacing as "Something went wrong submitting your
 * application" with no field for the wizard to bounce them to (QA could not
 * apply, and correctly reported missing nothing).
 *
 * DRAFT is deliberately exempt: restructuring before going live is the point of
 * a draft, and publishCycle is still the gate.
 */
const UNDELETABLE_FIELD_KEYS = new Set(["first_name", "last_name", "email", LANGUAGES_FIELD_KEY]);

/** Throws when removing `keys` would strip a published cycle of a required field. */
async function assertKeysRemovable(cycleId: string, keys: string[]): Promise<void> {
  const offending = keys.filter((k) => UNDELETABLE_FIELD_KEYS.has(k));
  if (offending.length === 0) return;
  const cycle = await prisma.recruitmentCycle.findUnique({ where: { id: cycleId }, select: { status: true } });
  if (!cycle || cycle.status === "DRAFT") return;
  throw new FormEditError(
    `This cycle is published, so it cannot lose ${offending.join(", ")}. ` +
    "Applicants would reach the end of the form and be unable to submit. " +
    "Close the cycle first if the form really needs restructuring.",
  );
}

export class FormEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormEditError";
  }
}

async function assertCycleEditable(cycleId: string, structural: boolean): Promise<void> {
  const cycle = await prisma.recruitmentCycle.findUnique({ where: { id: cycleId } });
  if (!cycle) throw new FormEditError("Cycle not found.");
  if (structural && cycle.status === "ARCHIVED") {
    throw new FormEditError("This cycle is archived and can no longer be edited.");
  }
}

/** Throws when `visibleWhen` is present, non-null, and does not parse as a
 *  valid FieldCondition -- an invalid condition is never persisted. */
function assertValidVisibleWhen(visibleWhen: unknown): void {
  if (visibleWhen === undefined || visibleWhen === null) return;
  if (!parseFieldCondition(visibleWhen)) {
    throw new FormEditError("Invalid visibility condition.");
  }
}

export async function addSection(
  cycleId: string,
  input: { title: string; appliesTo: ApplicantScope; departmentCode: string | null; description?: string; purpose?: "APPLICATION" | "QUIZ" }
): Promise<FormSection> {
  await assertCycleEditable(cycleId, false);
  const count = await prisma.formSection.count({ where: { cycleId } });
  return prisma.formSection.create({
    data: { cycleId, title: input.title, description: input.description ?? null, appliesTo: input.appliesTo, departmentCode: input.departmentCode, purpose: input.purpose ?? "APPLICATION", order: count },
  });
}

export async function addField(
  sectionId: string,
  input: {
    label: string; type: FieldType; required: boolean; helpText?: string; options?: unknown; validation?: unknown;
    correctValue?: string | null; visibleWhen?: unknown | null;
    /**
     * Explicit key, for SYSTEM fields whose key other code depends on (the
     * standard language question, see LANGUAGES_FIELD_KEY). Normally omitted, so
     * the key is derived from the label.
     *
     * Without this, deleting the seeded language question would be
     * unrecoverable through the UI: re-adding it would derive a key from the
     * label, which would not match, and the cycle could never be published.
     */
    key?: string;
  }
): Promise<FormField> {
  const section = await prisma.formSection.findUnique({ where: { id: sectionId } });
  if (!section) throw new FormEditError("Section not found.");
  assertValidVisibleWhen(input.visibleWhen);
  const structural = input.required === true && section.purpose !== "QUIZ";
  await assertCycleEditable(section.cycleId, structural);

  const existing = await prisma.formField.findMany({ where: { cycleId: section.cycleId }, select: { key: true } });
  if (input.key && existing.some((f) => f.key === input.key)) {
    throw new FormEditError(`A field with the key "${input.key}" already exists on this cycle.`);
  }
  // Fall back to the type name when the label is blank. Only NOTICE can legally
  // have one, and slugifyKey's own fallback would key every such field "field",
  // "field_2" -- meaningless in the stored answers of an acknowledging notice.
  const key = input.key ?? uniqueKey(input.label.trim() || input.type.toLowerCase(), existing.map((f) => f.key));
  const count = await prisma.formField.count({ where: { sectionId } });

  return prisma.formField.create({
    data: {
      sectionId, cycleId: section.cycleId, key, label: input.label, type: input.type,
      required: input.required, helpText: input.helpText ?? null,
      options: (input.options ?? undefined) as never, validation: (input.validation ?? undefined) as never,
      visibleWhen: (input.visibleWhen ?? undefined) as never,
      correctValue: input.correctValue ?? null,
      order: count,
    },
  });
}

export async function updateField(
  fieldId: string,
  patch: {
    label?: string; helpText?: string; type?: FieldType; required?: boolean; options?: unknown; validation?: unknown;
    correctValue?: string | null; visibleWhen?: unknown | null;
  }
): Promise<FormField> {
  const field = await prisma.formField.findUnique({ where: { id: fieldId }, include: { section: { select: { purpose: true } } } });
  if (!field) throw new FormEditError("Field not found.");
  assertValidVisibleWhen(patch.visibleWhen);

  // A visibleWhen change is structural: it changes whether/when a required
  // field is actually enforced, the same way flipping `required` itself is.
  const structural = field.section.purpose !== "QUIZ" && (
    (patch.type !== undefined && patch.type !== field.type) ||
    (patch.required === true && field.required === false) ||
    patch.visibleWhen !== undefined
  );
  await assertCycleEditable(field.cycleId, structural);

  // Deleting (or renaming the value of) an answer choice must not leave
  // correctValue pointing at an option that no longer exists. The quiz builder
  // edits options and the correct answer through two independent saves, so
  // removing the marked-correct choice silently orphaned correctValue: the
  // grader compares the applicant's answer against a value no radio can produce,
  // so that question was unanswerable-correctly and the makeup quiz became
  // unpassable, locking the learner out with no way to see why. Clearing it turns
  // the question ungraded (countGradedQuestions drops it) and leaves the builder
  // showing no choice marked correct, which is the prompt to pick a new one
  // (audit 14, quiz-correct-answer-orphaned-on-option-delete).
  const nextCorrect = patch.correctValue === undefined ? field.correctValue : patch.correctValue;
  const orphanedCorrect =
    patch.options !== undefined &&
    nextCorrect !== null &&
    !optionValues(patch.options).includes(nextCorrect);

  // A display-only NOTICE can never be required: it renders no control, so a
  // required flag left over from the type it used to be (switching a required
  // question to NOTICE, or switching a notice's acknowledgement back off) would
  // mark a field the applicant has no way to satisfy. Enforced here rather than
  // only in the builder so a stale client cannot persist the combination.
  const nextType = patch.type ?? field.type;
  const nextValidation = patch.validation === undefined ? field.validation : patch.validation;
  const forceUnrequired = isDisplayOnlyNotice({ type: nextType, validation: nextValidation });

  return prisma.formField.update({
    where: { id: fieldId },
    data: {
      label: patch.label ?? undefined,
      helpText: patch.helpText ?? undefined,
      type: patch.type ?? undefined,
      required: forceUnrequired ? false : (patch.required ?? undefined),
      options: patch.options === undefined ? undefined : (patch.options as never),
      validation: patch.validation === undefined ? undefined : (patch.validation as never),
      visibleWhen: patch.visibleWhen === undefined ? undefined : (patch.visibleWhen as never),
      correctValue: orphanedCorrect ? null : (patch.correctValue === undefined ? undefined : patch.correctValue),
    },
  });
}

/** The `value`s of an options payload ({value,label}[] as stored on FormField),
 *  tolerating the untyped `unknown` the callers pass through. */
function optionValues(options: unknown): string[] {
  if (!Array.isArray(options)) return [];
  return options
    .map((o) => (o && typeof o === "object" ? (o as { value?: unknown }).value : undefined))
    .filter((v): v is string => typeof v === "string");
}

export async function deleteField(fieldId: string): Promise<void> {
  const field = await prisma.formField.findUnique({ where: { id: fieldId }, include: { section: { select: { purpose: true } } } });
  if (!field) throw new FormEditError("Field not found.");
  await assertCycleEditable(field.cycleId, field.section.purpose !== "QUIZ");
  await assertKeysRemovable(field.cycleId, [field.key]);
  await prisma.formField.delete({ where: { id: fieldId } });
}

export async function reorderFields(sectionId: string, orderedFieldIds: string[]): Promise<void> {
  const section = await prisma.formSection.findUnique({ where: { id: sectionId } });
  if (!section) throw new FormEditError("Section not found.");
  await assertCycleEditable(section.cycleId, false);
  // Every supplied id must belong to this section; reject unknown/foreign ids.
  const owned = await prisma.formField.count({ where: { id: { in: orderedFieldIds }, sectionId } });
  if (owned !== orderedFieldIds.length) throw new FormEditError("Invalid field ids for this section.");
  // Renumber against the FULL field set, not just the supplied (visible) subset:
  // the builder can hide a field (e.g. the availability field when the term's
  // clinic calendar is empty), so a dense order=index over the subset would leave
  // the hidden field at a stale/colliding order and make orderBy non-deterministic
  // once it reappears (#104). Splice the supplied ids into the visible slots of the
  // current full order, leaving hidden fields anchored where they are.
  const finalOrder = spliceIntoFullOrder(
    (await prisma.formField.findMany({ where: { sectionId }, orderBy: { order: "asc" }, select: { id: true } })).map((f) => f.id),
    orderedFieldIds,
  );
  await prisma.$transaction(
    finalOrder.map((id, index) =>
      prisma.formField.updateMany({ where: { id, sectionId }, data: { order: index } })
    )
  );
}

export async function reorderSections(cycleId: string, orderedSectionIds: string[]): Promise<void> {
  await assertCycleEditable(cycleId, false);
  // Every supplied id must belong to this cycle; reject unknown/foreign ids.
  const owned = await prisma.formSection.count({ where: { id: { in: orderedSectionIds }, cycleId } });
  if (owned !== orderedSectionIds.length) throw new FormEditError("Invalid section ids for this cycle.");
  // Renumber against the FULL section set (see reorderFields): a hidden section --
  // e.g. the availability section, dropped from the builder when Term.clinicDates is
  // empty -- must not be left at a colliding order the visible drag never touched (#104).
  const finalOrder = spliceIntoFullOrder(
    (await prisma.formSection.findMany({ where: { cycleId }, orderBy: { order: "asc" }, select: { id: true } })).map((s) => s.id),
    orderedSectionIds,
  );
  await prisma.$transaction(
    finalOrder.map((id, index) =>
      prisma.formSection.updateMany({ where: { id, cycleId }, data: { order: index } })
    )
  );
}

/**
 * Reconcile a reordered VISIBLE subset back into the full ordered id list.
 *
 * `fullOrder` is every id (visible + hidden) in current order; `visibleNewOrder`
 * is the visible ids in their new relative order. Walk the full order and, at each
 * slot the drag actually touched (a visible id), take the next id from the new
 * visible sequence; leave every hidden id anchored in its current slot. The result
 * is a complete, collision-free ordering. When every id is visible it equals
 * `visibleNewOrder` verbatim (no behavior change for the common case).
 */
function spliceIntoFullOrder(fullOrder: string[], visibleNewOrder: string[]): string[] {
  const visible = new Set(visibleNewOrder);
  const queue = [...visibleNewOrder];
  return fullOrder.map((id) => (visible.has(id) ? queue.shift()! : id));
}

export async function updateSection(
  sectionId: string,
  patch: { title?: string; description?: string; appliesTo?: ApplicantScope; departmentCode?: string | null }
): Promise<FormSection> {
  const section = await prisma.formSection.findUnique({ where: { id: sectionId } });
  if (!section) throw new FormEditError("Section not found.");
  const structural =
    (patch.appliesTo !== undefined && patch.appliesTo !== section.appliesTo) ||
    (patch.departmentCode !== undefined && patch.departmentCode !== section.departmentCode);
  await assertCycleEditable(section.cycleId, structural);
  return prisma.formSection.update({
    where: { id: sectionId },
    data: {
      title: patch.title ?? undefined,
      description: patch.description ?? undefined,
      appliesTo: patch.appliesTo ?? undefined,
      departmentCode: patch.departmentCode === undefined ? undefined : patch.departmentCode,
    },
  });
}

export async function deleteSection(sectionId: string): Promise<void> {
  const section = await prisma.formSection.findUnique({
    where: { id: sectionId },
    include: { fields: { select: { key: true } } },
  });
  if (!section) throw new FormEditError("Section not found.");
  await assertCycleEditable(section.cycleId, true);
  // Deleting a section cascades to its fields, so it can strip a required key
  // just as deleteField can.
  await assertKeysRemovable(section.cycleId, section.fields.map((f) => f.key));
  await prisma.formSection.delete({ where: { id: sectionId } });
}
