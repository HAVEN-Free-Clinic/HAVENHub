/**
 * Forms: build a form, send it to people, collect and read the answers.
 *
 * Permission checks are the caller's job (forms.manage for every staff
 * function here). The respondent-side functions (fillableForm,
 * submitResponse, formsForPerson) take the signed-in person's id and enforce
 * who may respond themselves, since that rule is about the form, not the page.
 */
import type { FormStatus, Prisma } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { queueEmails } from "@/platform/email/send";
import { renderInlineEmail } from "@/platform/email/templates/renderEmail";
import { getSetting } from "@/platform/settings/service";
import { formatDateOnly } from "@/platform/dates/format";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import { esc as escapeHtml } from "@/platform/email/render/escape";
import { resolveAudience } from "@/platform/email/audience/resolve";
import type { Audience } from "@/platform/email/audience/types";
import {
  EMPTY_LAYOUT,
  parseFormLayout,
  readLayoutLenient,
  validateAnswers,
  type Answers,
  type FormLayout,
} from "./layout";
import { getTemplate } from "./templates";

export class FormError extends Error {
  problems: string[];
  constructor(problems: string[] | string) {
    const list = Array.isArray(problems) ? problems : [problems];
    super(list.join(" "));
    this.name = "FormError";
    this.problems = list;
  }
}

/** Someone else saved the form since this editor loaded it. */
export class FormConflictError extends Error {
  savedByName: string | null;
  savedAt: Date;
  constructor(savedByName: string | null, savedAt: Date) {
    super("Form was saved by someone else since it was loaded");
    this.name = "FormConflictError";
    this.savedByName = savedByName;
    this.savedAt = savedAt;
  }
}

// ---------------------------------------------------------------------------
// Staff: building
// ---------------------------------------------------------------------------

export async function listForms() {
  const forms = await prisma.form.findMany({
    orderBy: [{ updatedAt: "desc" }],
    select: {
      id: true,
      title: true,
      status: true,
      updatedAt: true,
      closesAt: true,
      openToAnyone: true,
      updatedBy: { select: { name: true } },
      _count: { select: { assignments: true, responses: true } },
    },
  });
  return forms;
}

export async function createForm(
  actorId: string,
  input: { title: string; templateId?: string | null },
): Promise<{ id: string }> {
  const template = getTemplate(input.templateId);
  const title = input.title.trim() || template?.title || "Untitled form";
  const form = await prisma.form.create({
    data: {
      title,
      description: template?.description ?? "",
      layout: (template?.layout ?? EMPTY_LAYOUT) as Prisma.InputJsonValue,
      createdById: actorId,
      updatedById: actorId,
    },
  });
  await recordAudit({
    actorPersonId: actorId,
    action: "form.create",
    entityType: "Form",
    entityId: form.id,
    after: { title, templateId: template?.id ?? null },
  });
  return { id: form.id };
}

export async function getForm(id: string) {
  const form = await prisma.form.findUnique({
    where: { id },
    include: {
      updatedBy: { select: { name: true } },
      _count: { select: { assignments: true, responses: true } },
    },
  });
  if (!form) return null;
  return { ...form, parsedLayout: readLayoutLenient(form.layout) };
}

export type FormSettingsInput = {
  title: string;
  description: string;
  layout: unknown;
  openToAnyone: boolean;
  allowEdits: boolean;
  closesAt: Date | null;
  /** The layoutVersion the editor loaded. Omit to overwrite unconditionally. */
  expectedVersion?: number;
};

export async function updateForm(actorId: string, id: string, input: FormSettingsInput): Promise<void> {
  const title = input.title.trim();
  if (!title) throw new FormError("Give the form a title.");
  const layout = parseFormLayout(input.layout);

  const { count } = await prisma.form.updateMany({
    where: { id, ...(input.expectedVersion !== undefined ? { layoutVersion: input.expectedVersion } : {}) },
    data: {
      title,
      description: input.description.trim(),
      layout: layout as Prisma.InputJsonValue,
      openToAnyone: input.openToAnyone,
      allowEdits: input.allowEdits,
      closesAt: input.closesAt,
      updatedById: actorId,
      layoutVersion: { increment: 1 },
    },
  });
  if (count === 0) {
    const current = await prisma.form.findUnique({
      where: { id },
      select: { updatedAt: true, updatedBy: { select: { name: true } } },
    });
    if (!current) throw new FormError("This form no longer exists.");
    throw new FormConflictError(current.updatedBy?.name ?? null, current.updatedAt);
  }
  await recordAudit({
    actorPersonId: actorId,
    action: "form.update",
    entityType: "Form",
    entityId: id,
    after: { questions: layout.questions.length },
  });
}

export async function setFormStatus(actorId: string, id: string, status: FormStatus): Promise<void> {
  const form = await prisma.form.findUniqueOrThrow({ where: { id } });
  if (status === "OPEN") {
    const layout = parseFormLayout(form.layout);
    if (!layout.questions.some((q) => q.type !== "section")) {
      throw new FormError("Add at least one question before opening the form.");
    }
  }
  await prisma.form.update({ where: { id }, data: { status } });
  await recordAudit({
    actorPersonId: actorId,
    action: "form.status",
    entityType: "Form",
    entityId: id,
    before: { status: form.status },
    after: { status },
  });
}

export async function duplicateForm(actorId: string, id: string): Promise<{ id: string }> {
  const source = await prisma.form.findUniqueOrThrow({ where: { id } });
  const copy = await prisma.form.create({
    data: {
      title: `Copy of ${source.title}`,
      description: source.description,
      layout: source.layout as Prisma.InputJsonValue,
      openToAnyone: source.openToAnyone,
      allowEdits: source.allowEdits,
      createdById: actorId,
      updatedById: actorId,
    },
  });
  await recordAudit({
    actorPersonId: actorId,
    action: "form.duplicate",
    entityType: "Form",
    entityId: copy.id,
    after: { sourceId: id },
  });
  return { id: copy.id };
}

/** Deletes a form with no responses. One with responses is closed instead, keeping the record. */
export async function deleteForm(actorId: string, id: string): Promise<void> {
  const { count } = await prisma.form.deleteMany({ where: { id, responses: { none: {} } } });
  if (count === 0) {
    throw new FormError("A form with responses cannot be deleted. Close it instead.");
  }
  await recordAudit({ actorPersonId: actorId, action: "form.delete", entityType: "Form", entityId: id });
}

// ---------------------------------------------------------------------------
// Staff: assigning
// ---------------------------------------------------------------------------

async function formLink(formId: string): Promise<string> {
  const base = (await getSetting<string>("app.baseUrl")).replace(/\/$/, "");
  return `${base}/my-info/forms/${formId}`;
}

async function emailPeople(
  actorId: string | null,
  form: { id: string; title: string; closesAt: Date | null },
  people: Array<{ id: string; contactEmail: string | null; name: string; preferredFirstName: string | null }>,
  kind: "assigned" | "reminder",
): Promise<number> {
  const link = await formLink(form.id);
  const withEmail = people.filter((p) => p.contactEmail);
  const title = escapeHtml(form.title);
  const due = form.closesAt
    ? ` by ${formatDateOnly(form.closesAt, await getDisplayTimeZone(), { month: "long", day: "numeric" })}`
    : "";
  const rendered = await Promise.all(
    withEmail.map(async (p) => {
      const first = escapeHtml(p.preferredFirstName || p.name.split(" ")[0] || "there");
      const { subject, html } = await renderInlineEmail(
        {
          subject: kind === "assigned" ? `Please fill out: ${form.title}` : `Reminder: ${form.title}`,
          body:
            kind === "assigned"
              ? `<p>Hi ${first},</p><p>You have been asked to fill out <strong>${title}</strong>${due}.</p><p><a href="${link}">Open the form</a></p>`
              : `<p>Hi ${first},</p><p>This is a reminder to fill out <strong>${title}</strong>${due}. It only takes a few minutes.</p><p><a href="${link}">Open the form</a></p>`,
        },
        {},
      );
      return { to: p.contactEmail as string, subject, html, personId: p.id, triggeredById: actorId };
    }),
  );
  await queueEmails(prisma, kind === "assigned" ? "forms:assigned" : "forms:reminder", rendered);
  return rendered.length;
}

export type AssignResult = { added: number; alreadyAssigned: number; emailed: number; notFound: string[] };

async function assignPeople(
  actorId: string,
  formId: string,
  personIds: string[],
  opts: { notify: boolean },
): Promise<Omit<AssignResult, "notFound">> {
  const form = await prisma.form.findUniqueOrThrow({ where: { id: formId } });
  const unique = [...new Set(personIds)];
  const existing = await prisma.formAssignment.findMany({
    where: { formId, personId: { in: unique } },
    select: { personId: true },
  });
  const had = new Set(existing.map((e) => e.personId));
  const fresh = unique.filter((id) => !had.has(id));
  if (fresh.length > 0) {
    await prisma.formAssignment.createMany({
      data: fresh.map((personId) => ({ formId, personId, assignedById: actorId })),
      skipDuplicates: true,
    });
  }
  let emailed = 0;
  // Only people newly assigned are emailed: re-running an assignment to catch
  // a few latecomers must not re-send to everyone already on it.
  if (opts.notify && fresh.length > 0 && form.status === "OPEN") {
    const people = await prisma.person.findMany({
      where: { id: { in: fresh }, status: "ACTIVE" },
      select: { id: true, contactEmail: true, name: true, preferredFirstName: true },
    });
    emailed = await emailPeople(actorId, form, people, "assigned");
  }
  if (fresh.length > 0) {
    await recordAudit({
      actorPersonId: actorId,
      action: "form.assign",
      entityType: "Form",
      entityId: formId,
      after: { added: fresh.length, emailed },
    });
  }
  return { added: fresh.length, alreadyAssigned: unique.length - fresh.length, emailed };
}

/** Assigns everyone an Outreach-style audience resolves to who has a Hub account. */
export async function assignByAudience(
  actorId: string,
  formId: string,
  audience: Audience,
  opts: { notify: boolean },
): Promise<AssignResult> {
  const { recipients } = await resolveAudience(audience);
  const ids = recipients.flatMap((r) => (r.recordId ? [r.recordId] : []));
  return { ...(await assignPeople(actorId, formId, ids, opts)), notFound: [] };
}

/** Assigns by pasted NetIDs and emails, matched case-insensitively. */
export async function assignByIdentifiers(
  actorId: string,
  formId: string,
  identifiers: string[],
  opts: { notify: boolean },
): Promise<AssignResult> {
  const people = await prisma.person.findMany({
    where: { OR: [{ netId: { not: null } }, { contactEmail: { not: null } }] },
    select: { id: true, netId: true, contactEmail: true },
  });
  const byKey = new Map<string, string>();
  for (const p of people) {
    if (p.netId) byKey.set(p.netId.toLowerCase(), p.id);
    if (p.contactEmail) byKey.set(p.contactEmail.toLowerCase(), p.id);
  }
  const ids: string[] = [];
  const notFound: string[] = [];
  for (const raw of identifiers) {
    const id = byKey.get(raw.toLowerCase());
    if (id) ids.push(id);
    else notFound.push(raw);
  }
  return { ...(await assignPeople(actorId, formId, ids, opts)), notFound };
}

export async function unassign(actorId: string, formId: string, personId: string): Promise<void> {
  await prisma.formAssignment.deleteMany({ where: { formId, personId } });
  await recordAudit({
    actorPersonId: actorId,
    action: "form.unassign",
    entityType: "Form",
    entityId: formId,
    after: { personId },
  });
}

/** Emails everyone assigned who has not responded yet. Returns how many were emailed. */
export async function remindNonResponders(actorId: string, formId: string): Promise<number> {
  const form = await prisma.form.findUniqueOrThrow({ where: { id: formId } });
  if (form.status !== "OPEN") throw new FormError("Only an open form can send reminders.");
  const pending = await prisma.formAssignment.findMany({
    where: { formId, person: { status: "ACTIVE", formResponses: { none: { formId } } } },
    select: { id: true, person: { select: { id: true, contactEmail: true, name: true, preferredFirstName: true } } },
  });
  const emailed = await emailPeople(actorId, form, pending.map((p) => p.person), "reminder");
  await prisma.formAssignment.updateMany({
    where: { id: { in: pending.map((p) => p.id) } },
    data: { remindedAt: new Date() },
  });
  await recordAudit({
    actorPersonId: actorId,
    action: "form.remind",
    entityType: "Form",
    entityId: formId,
    after: { emailed },
  });
  return emailed;
}

/** Assigned people with whether each has responded, for the completion view. */
export async function assignmentStatus(formId: string) {
  const [assignments, responders] = await Promise.all([
    prisma.formAssignment.findMany({
      where: { formId },
      select: {
        assignedAt: true,
        remindedAt: true,
        person: { select: { id: true, name: true, contactEmail: true, status: true } },
      },
      orderBy: { person: { name: "asc" } },
    }),
    prisma.formResponse.findMany({ where: { formId, personId: { not: null } }, select: { personId: true } }),
  ]);
  const done = new Set(responders.map((r) => r.personId));
  return assignments.map((a) => ({ ...a, responded: done.has(a.person.id) }));
}

// ---------------------------------------------------------------------------
// Respondents
// ---------------------------------------------------------------------------

function isAcceptingAt(form: { status: FormStatus; closesAt: Date | null }, now: Date): boolean {
  return form.status === "OPEN" && (!form.closesAt || form.closesAt > now);
}

export type FillableForm = {
  id: string;
  title: string;
  description: string;
  layout: FormLayout;
  accepting: boolean;
  allowEdits: boolean;
  closesAt: Date | null;
  existing: { answers: Record<string, string | string[]>; submittedAt: Date } | null;
};

/**
 * The form as one person may see it, or null when they may not: a draft, or a
 * form they were neither assigned nor sent an open link to. A closed form an
 * assignee already answered stays viewable, read-only.
 */
export async function fillableForm(personId: string, formId: string, now = new Date()): Promise<FillableForm | null> {
  const form = await prisma.form.findUnique({ where: { id: formId } });
  if (!form || form.status === "DRAFT") return null;
  const [assignment, response] = await Promise.all([
    prisma.formAssignment.findUnique({ where: { formId_personId: { formId, personId } } }),
    prisma.formResponse.findUnique({ where: { formId_personId: { formId, personId } } }),
  ]);
  if (!assignment && !response && !form.openToAnyone) return null;
  return {
    id: form.id,
    title: form.title,
    description: form.description,
    layout: readLayoutLenient(form.layout),
    accepting: isAcceptingAt(form, now),
    allowEdits: form.allowEdits,
    closesAt: form.closesAt,
    existing: response
      ? { answers: response.answers as Record<string, string | string[]>, submittedAt: response.submittedAt }
      : null,
  };
}

export async function submitResponse(
  personId: string,
  formId: string,
  raw: Answers,
  now = new Date(),
): Promise<void> {
  const fillable = await fillableForm(personId, formId, now);
  if (!fillable) throw new FormError("This form is not available to you.");
  if (!fillable.accepting) throw new FormError("This form is no longer accepting responses.");
  if (fillable.existing && !fillable.allowEdits) {
    throw new FormError("You have already responded, and this form does not allow changes.");
  }
  const { answers, problems } = validateAnswers(fillable.layout, raw);
  if (problems.length > 0) throw new FormError(problems);

  await prisma.formResponse.upsert({
    where: { formId_personId: { formId, personId } },
    create: {
      formId,
      personId,
      answers: answers as Prisma.InputJsonValue,
      layoutSnapshot: fillable.layout as Prisma.InputJsonValue,
      submittedAt: now,
    },
    update: {
      answers: answers as Prisma.InputJsonValue,
      layoutSnapshot: fillable.layout as Prisma.InputJsonValue,
      submittedAt: now,
    },
  });
  await recordAudit({
    actorPersonId: personId,
    action: fillable.existing ? "form.response_update" : "form.response_submit",
    entityType: "Form",
    entityId: formId,
  });
}

export type PersonFormRow = {
  id: string;
  title: string;
  closesAt: Date | null;
  accepting: boolean;
  submittedAt: Date | null;
};

/** Forms assigned to or answered by this person, pending first. */
export async function formsForPerson(personId: string, now = new Date()): Promise<PersonFormRow[]> {
  const forms = await prisma.form.findMany({
    where: {
      status: { not: "DRAFT" },
      OR: [{ assignments: { some: { personId } } }, { responses: { some: { personId } } }],
    },
    select: {
      id: true,
      title: true,
      status: true,
      closesAt: true,
      responses: { where: { personId }, select: { submittedAt: true } },
    },
  });
  return forms
    .map((f) => ({
      id: f.id,
      title: f.title,
      closesAt: f.closesAt,
      accepting: isAcceptingAt(f, now),
      submittedAt: f.responses[0]?.submittedAt ?? null,
    }))
    .sort((a, b) => {
      const ap = a.submittedAt === null && a.accepting ? 0 : 1;
      const bp = b.submittedAt === null && b.accepting ? 0 : 1;
      return ap - bp || a.title.localeCompare(b.title);
    });
}

/** How many open forms this person still has to fill, for the dashboard. */
export async function pendingFormCount(personId: string, now = new Date()): Promise<number> {
  return prisma.form.count({
    where: {
      status: "OPEN",
      OR: [{ closesAt: null }, { closesAt: { gt: now } }],
      assignments: { some: { personId } },
      responses: { none: { personId } },
    },
  });
}

// ---------------------------------------------------------------------------
// Staff: results
// ---------------------------------------------------------------------------

export type ResponseRow = {
  id: string;
  personId: string | null;
  name: string;
  email: string | null;
  submittedAt: Date;
  source: "HUB" | "AIRTABLE";
  answers: Record<string, string | string[]>;
};

export async function listResponses(formId: string): Promise<ResponseRow[]> {
  const rows = await prisma.formResponse.findMany({
    where: { formId },
    orderBy: { submittedAt: "desc" },
    include: { person: { select: { name: true, contactEmail: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    personId: r.personId,
    name: r.person?.name ?? r.importedName ?? "Unknown",
    email: r.person?.contactEmail ?? null,
    submittedAt: r.submittedAt,
    source: r.source,
    answers: (r.answers ?? {}) as Record<string, string | string[]>,
  }));
}

export type QuestionSummary =
  | { key: string; label: string; kind: "choice"; answered: number; counts: Array<{ option: string; count: number }> }
  | { key: string; label: string; kind: "rating"; answered: number; max: number; average: number | null; counts: number[] }
  | { key: string; label: string; kind: "text"; answered: number; answers: Array<{ name: string; text: string }> };

/** Per-question roll-up for the Results tab, against the form's current layout. */
export function summarize(layout: FormLayout, responses: ResponseRow[]): QuestionSummary[] {
  const out: QuestionSummary[] = [];
  for (const q of layout.questions) {
    if (q.type === "section") continue;
    const values = responses
      .map((r) => ({ name: r.name, value: r.answers[q.key] }))
      .filter((v) => v.value !== undefined && v.value !== "" && !(Array.isArray(v.value) && v.value.length === 0));
    if (q.type === "single_choice" || q.type === "multi_choice") {
      const tally = new Map<string, number>((q.options ?? []).map((o) => [o, 0]));
      for (const { value } of values) {
        for (const v of Array.isArray(value) ? value : [value as string]) {
          const label = v.startsWith("Other: ") ? "Other" : v;
          tally.set(label, (tally.get(label) ?? 0) + 1);
        }
      }
      out.push({
        key: q.key,
        label: q.label,
        kind: "choice",
        answered: values.length,
        counts: [...tally].map(([option, count]) => ({ option, count })),
      });
    } else if (q.type === "rating") {
      const max = q.scale?.max ?? 5;
      const counts = Array.from({ length: max }, () => 0);
      let sum = 0;
      let n = 0;
      for (const { value } of values) {
        const v = Number(value);
        if (Number.isInteger(v) && v >= 1 && v <= max) {
          counts[v - 1]++;
          sum += v;
          n++;
        }
      }
      out.push({ key: q.key, label: q.label, kind: "rating", answered: n, max, average: n ? sum / n : null, counts });
    } else {
      out.push({
        key: q.key,
        label: q.label,
        kind: "text",
        answered: values.length,
        answers: values.map((v) => ({ name: v.name, text: String(v.value) })),
      });
    }
  }
  return out;
}

function csvCell(v: string): string {
  // A leading =, +, - or @ is a formula to a spreadsheet. Respondents write
  // these cells, so neutralise them before staff open the export.
  const safe = /^[=+\-@]/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** One row per response; columns follow the current layout, then any keys only older snapshots had. */
export function responsesCsv(layout: FormLayout, responses: ResponseRow[]): string {
  const questions = layout.questions.filter((q) => q.type !== "section");
  const known = new Set(questions.map((q) => q.key));
  const extra = [...new Set(responses.flatMap((r) => Object.keys(r.answers)))].filter((k) => !known.has(k));
  const header = ["Name", "Email", "Submitted", "Source", ...questions.map((q) => q.label), ...extra];
  const lines = [header.map(csvCell).join(",")];
  for (const r of responses) {
    const cells = [
      r.name,
      r.email ?? "",
      r.submittedAt.toISOString(),
      r.source === "AIRTABLE" ? "Airtable" : "Hub",
      ...[...questions.map((q) => q.key), ...extra].map((k) => {
        const v = r.answers[k];
        return Array.isArray(v) ? v.join("; ") : (v ?? "");
      }),
    ];
    lines.push(cells.map(csvCell).join(","));
  }
  return lines.join("\r\n");
}
