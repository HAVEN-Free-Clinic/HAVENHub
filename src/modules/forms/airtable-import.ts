/**
 * Builds a Hub form from an Airtable table and imports its rows as responses.
 *
 * For bringing the clinic's past Airtable surveys (e.g. "Mid-Semester
 * Feedback SU26") into the Hub with their history. The table's fields become
 * questions; its rows become FormResponses, matched to people through the
 * Person.airtableRecordId the original roster import kept.
 *
 * The respondent is the table's first person-link field (Airtable forms
 * collect it as "Select your name"). Lookups, formulas, auto-numbers and the
 * like are derived data, not answers, so they are skipped; a created-time
 * field becomes the submission time.
 *
 * Re-running against the same table updates the existing form's responses in
 * place (FormResponse.externalId), so a second import after more rows arrive
 * adds only the new ones.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { AirtableClient, type AirtableFieldSchema, type AirtableRecord, type AirtableTableSchema } from "@/platform/airtable/client";
import { keyFromLabel, parseFormLayout, type FormLayout, type Question } from "./layout";

export class AirtableImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AirtableImportError";
  }
}

/** Pulls base and table ids out of a pasted Airtable URL, or takes them as given. */
export function parseAirtableRef(input: string): { baseId: string; tableId: string } | null {
  const base = input.match(/\b(app[A-Za-z0-9]{14})\b/);
  const table = input.match(/\b(tbl[A-Za-z0-9]{14})\b/);
  return base && table ? { baseId: base[1], tableId: table[1] } : null;
}

type FieldPlan =
  | { kind: "question"; field: AirtableFieldSchema; question: Question }
  | { kind: "respondent"; field: AirtableFieldSchema }
  | { kind: "submittedAt"; field: AirtableFieldSchema };

/** Decides what each field becomes. Pure, so it can be tested on a schema alone. */
export function planFields(table: AirtableTableSchema): FieldPlan[] {
  const plans: FieldPlan[] = [];
  const taken = new Set<string>();
  let haveRespondent = false;
  let haveSubmittedAt = false;
  for (const field of table.fields) {
    const choices = field.options?.choices?.map((c) => c.name) ?? [];
    const base = { label: field.name.slice(0, 500), help: field.description?.slice(0, 2000) || undefined };
    const key = () => {
      const k = keyFromLabel(field.name, taken);
      taken.add(k);
      return k;
    };
    switch (field.type) {
      case "multipleRecordLinks":
        if (!haveRespondent) {
          plans.push({ kind: "respondent", field });
          haveRespondent = true;
        }
        break;
      case "createdTime":
        if (!haveSubmittedAt) {
          plans.push({ kind: "submittedAt", field });
          haveSubmittedAt = true;
        }
        break;
      case "singleSelect":
        plans.push({ kind: "question", field, question: { key: key(), type: "single_choice", ...base, options: choices.length ? choices : ["(none)"] } });
        break;
      case "multipleSelects":
        plans.push({ kind: "question", field, question: { key: key(), type: "multi_choice", ...base, options: choices.length ? choices : ["(none)"] } });
        break;
      case "checkbox":
        plans.push({ kind: "question", field, question: { key: key(), type: "single_choice", ...base, options: ["Yes", "No"] } });
        break;
      case "rating":
        plans.push({
          kind: "question",
          field,
          question: { key: key(), type: "rating", ...base, scale: { max: Math.min(Math.max(field.options?.max ?? 5, 2), 10) } },
        });
        break;
      case "multilineText":
      case "richText":
        plans.push({ kind: "question", field, question: { key: key(), type: "long_text", ...base } });
        break;
      case "singleLineText":
      case "email":
      case "phoneNumber":
      case "url":
      case "number":
      case "percent":
      case "currency":
      case "date":
      case "dateTime":
        plans.push({ kind: "question", field, question: { key: key(), type: "short_text", ...base } });
        break;
      default:
        // Lookups, rollups, formulas, autoNumber, attachments, collaborators:
        // derived or not an answer someone typed.
        break;
    }
  }
  return plans;
}

/** One cell to the string / string[] shape FormResponse.answers stores. */
function cellToAnswer(question: Question, value: unknown): string | string[] | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  switch (question.type) {
    case "multi_choice":
      return Array.isArray(value) ? value.map(String) : [String(value)];
    case "single_choice":
      if (typeof value === "boolean") return value ? "Yes" : "No";
      return String(value);
    case "rating":
      return String(value);
    default:
      return Array.isArray(value) ? value.map(String).join(", ") : String(value);
  }
}

/**
 * The form's questions, with every value actually seen in the rows added to
 * the options. Airtable keeps old answers after an option is renamed or
 * removed; dropping those would silently lose responses.
 */
function widenOptions(plans: FieldPlan[], records: AirtableRecord[]): FormLayout {
  const questions: Question[] = [];
  for (const plan of plans) {
    if (plan.kind !== "question") continue;
    const q = { ...plan.question };
    if (q.type === "single_choice" || q.type === "multi_choice") {
      const options = new Set((q.options ?? []).filter((o) => o !== "(none)"));
      for (const r of records) {
        const a = cellToAnswer(q, r.fields[plan.field.id]);
        for (const v of Array.isArray(a) ? a : a ? [a] : []) options.add(v);
      }
      q.options = [...options].slice(0, 50);
      if (q.options.length === 0) q.options = ["(none)"];
    }
    questions.push(q);
  }
  return { questions };
}

export type AirtableImportResult = { formId: string; imported: number; matched: number; unmatched: number };

export async function importAirtableTable(
  actorId: string,
  input: { pat: string; baseId: string; tableId: string; title?: string },
  client: AirtableClient = new AirtableClient(input.pat),
): Promise<AirtableImportResult> {
  let tables: AirtableTableSchema[];
  try {
    tables = await client.listTables(input.baseId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new AirtableImportError(
      msg.includes(" 403 ") || msg.includes(" 401 ")
        ? "Airtable refused to share this base's structure. The Hub's Airtable token needs read access to the base, including its schema."
        : `Could not read the Airtable base: ${msg}`,
    );
  }
  const table = tables.find((t) => t.id === input.tableId);
  if (!table) throw new AirtableImportError("That table is not in that base.");

  const plans = planFields(table);
  const records = await client.listAll(input.baseId, input.tableId);
  const layout = parseFormLayout(widenOptions(plans, records));
  if (layout.questions.length === 0) {
    throw new AirtableImportError("That table has no fields the Hub can turn into questions.");
  }

  const respondent = plans.find((p) => p.kind === "respondent")?.field;
  const submittedAtField = plans.find((p) => p.kind === "submittedAt")?.field;
  const questionPlans = plans.filter((p): p is Extract<FieldPlan, { kind: "question" }> => p.kind === "question");

  // People by their Airtable record id, for every id any row links to.
  const linkedIds = respondent
    ? [...new Set(records.flatMap((r) => (Array.isArray(r.fields[respondent.id]) ? (r.fields[respondent.id] as string[]) : [])))]
    : [];
  const people = linkedIds.length
    ? await prisma.person.findMany({ where: { airtableRecordId: { in: linkedIds } }, select: { id: true, airtableRecordId: true, name: true } })
    : [];
  const personByRecord = new Map(people.map((p) => [p.airtableRecordId as string, p]));

  // Names for rows whose person the Hub does not know, from the linked table's
  // primary field. Only fetched when needed.
  const unmatchedLinks = linkedIds.filter((id) => !personByRecord.has(id));
  const linkedNames = new Map<string, string>();
  if (respondent && unmatchedLinks.length > 0 && respondent.options?.linkedTableId) {
    const linkedTable = tables.find((t) => t.id === respondent.options!.linkedTableId);
    if (linkedTable) {
      const linkedRecords = await client.listAll(input.baseId, linkedTable.id);
      for (const r of linkedRecords) {
        const name = r.fields[linkedTable.primaryFieldId];
        if (typeof name === "string") linkedNames.set(r.id, name);
      }
    }
  }

  const externalPrefix = `airtable:${input.baseId}:${input.tableId}:`;
  const existing = await prisma.formResponse.findFirst({
    where: { externalId: { startsWith: externalPrefix } },
    select: { formId: true },
  });
  const formId =
    existing?.formId ??
    (
      await prisma.form.create({
        data: {
          title: input.title?.trim() || table.name,
          description: `Imported from Airtable (${table.name}).`,
          status: "CLOSED",
          layout: layout as Prisma.InputJsonValue,
          createdById: actorId,
          updatedById: actorId,
        },
      })
    ).id;
  if (existing) {
    // Widen the existing form's layout with anything new in the table.
    await prisma.form.update({
      where: { id: formId },
      data: { layout: layout as Prisma.InputJsonValue, updatedById: actorId, layoutVersion: { increment: 1 } },
    });
  }

  // Oldest first, so when someone answered twice the LATER answer is the one
  // tied to their person (a FormResponse is one per person per form) and the
  // earlier one is kept by name only.
  const ordered = [...records].sort((a, b) => (a.createdTime ?? "").localeCompare(b.createdTime ?? ""));
  const claimed = new Map<string, string>(); // personId -> externalId holding it
  for (const r of ordered) {
    const link = respondent ? (r.fields[respondent.id] as string[] | undefined)?.[0] : undefined;
    const person = link ? personByRecord.get(link) : undefined;
    if (person) claimed.set(person.id, `${externalPrefix}${r.id}`);
  }

  let matched = 0;
  let unmatched = 0;
  for (const r of ordered) {
    const answers: Record<string, string | string[]> = {};
    for (const plan of questionPlans) {
      const a = cellToAnswer(plan.question, r.fields[plan.field.id]);
      if (a !== undefined && !(Array.isArray(a) && a.length === 0)) answers[plan.question.key] = a;
    }
    const externalId = `${externalPrefix}${r.id}`;
    const link = respondent ? (r.fields[respondent.id] as string[] | undefined)?.[0] : undefined;
    const person = link ? personByRecord.get(link) : undefined;
    const ownsPerson = person && claimed.get(person.id) === externalId;
    const submittedRaw = submittedAtField ? r.fields[submittedAtField.id] : r.createdTime;
    const submittedAt = typeof submittedRaw === "string" ? new Date(submittedRaw) : new Date();
    const data = {
      formId,
      personId: ownsPerson ? person.id : null,
      importedName: person?.name ?? (link ? linkedNames.get(link) : undefined) ?? null,
      answers: answers as Prisma.InputJsonValue,
      layoutSnapshot: layout as Prisma.InputJsonValue,
      source: "AIRTABLE" as const,
      submittedAt,
    };
    await prisma.formResponse.upsert({ where: { externalId }, create: { ...data, externalId }, update: data });
    if (ownsPerson) matched++;
    else unmatched++;
  }

  await recordAudit({
    actorPersonId: actorId,
    action: "form.airtable_import",
    entityType: "Form",
    entityId: formId,
    after: { baseId: input.baseId, tableId: input.tableId, imported: records.length, matched, unmatched },
  });
  return { formId, imported: records.length, matched, unmatched };
}
