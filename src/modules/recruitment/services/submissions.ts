import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Application, FieldType } from "@prisma/client";
import { prisma } from "@/platform/db";
import { getSetting } from "@/platform/settings/service";
import { putObject, deleteObject } from "@/platform/storage";
import { queueEmail } from "@/platform/email/send";
import { recordAudit } from "@/platform/audit";
import {
  buildApplicationSchema, requiredFileKeys,
  type SectionDef, type FieldDef,
} from "../engine/schema-builder";
import { visibleSections, type ApplicantType } from "../engine/visibility";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export class CycleNotOpenError extends Error { constructor(m = "This application is closed.") { super(m); this.name = "CycleNotOpenError"; } }
export class DuplicateApplicationError extends Error { constructor(m = "You have already applied.") { super(m); this.name = "DuplicateApplicationError"; } }
export class SubmissionValidationError extends Error {
  fieldErrors: Record<string, string>;
  constructor(message: string, fieldErrors: Record<string, string> = {}) { super(message); this.name = "SubmissionValidationError"; this.fieldErrors = fieldErrors; }
}

export type UploadedFile = { fileName: string; mimeType: string; bytes: Buffer };

export type SubmitInput = {
  applicantType: ApplicantType;
  renewalDepartment?: string;
  answers: Record<string, unknown>;
  files: Record<string, UploadedFile>;
};

const DEPT_CHOICE_KEY_TYPE: FieldType = "DEPARTMENT_CHOICE";

function toSectionDefs(
  sections: { id: string; appliesTo: SectionDef["appliesTo"]; departmentCode: string | null; fields: { key: string; type: FieldType; required: boolean; options: unknown; validation: unknown }[] }[],
  departments: string[],
  applicantType: ApplicantType
): SectionDef[] {
  return sections.map((s) => ({
    id: s.id,
    appliesTo: s.appliesTo,
    departmentCode: s.departmentCode,
    fields: s.fields.map((f): FieldDef => ({
      key: f.key,
      type: f.type,
      // Renewals declare their department via `renewalDepartment`, so the
      // NEW-applicant department-choice field is not required for them.
      required: f.type === DEPT_CHOICE_KEY_TYPE && applicantType === "RENEWAL" ? false : f.required,
      options: f.type === DEPT_CHOICE_KEY_TYPE ? departments.map((d) => ({ value: d, label: d })) : (f.options as FieldDef["options"]) ?? null,
      validation: (f.validation as FieldDef["validation"]) ?? null,
    })),
  }));
}

export async function submitApplication(slug: string, input: SubmitInput): Promise<Application> {
  const cycle = await prisma.recruitmentCycle.findUnique({
    where: { publicSlug: slug },
    include: { sections: { where: { purpose: "APPLICATION" }, include: { fields: { orderBy: { order: "asc" } } }, orderBy: { order: "asc" } } },
  });
  if (!cycle) throw new CycleNotOpenError("Application not found.");

  const now = new Date();
  const open = cycle.status === "OPEN" && (!cycle.opensAt || cycle.opensAt <= now) && (!cycle.closesAt || cycle.closesAt >= now);
  if (!open) throw new CycleNotOpenError();
  if (input.applicantType === "RENEWAL" && !cycle.acceptsRenewals) throw new CycleNotOpenError("This cycle does not accept renewals.");

  const sectionDefs = toSectionDefs(cycle.sections, cycle.departments, input.applicantType);

  let selectedDepartmentCodes: string[];
  if (input.applicantType === "RENEWAL") {
    if (!input.renewalDepartment || !cycle.departments.includes(input.renewalDepartment)) {
      throw new SubmissionValidationError("Choose the department you are renewing in.", { renewalDepartment: "required" });
    }
    selectedDepartmentCodes = [input.renewalDepartment];
  } else {
    const deptField = cycle.sections.flatMap((s) => s.fields).find((f) => f.type === DEPT_CHOICE_KEY_TYPE);
    const raw = deptField ? input.answers[deptField.key] : undefined;
    selectedDepartmentCodes = Array.isArray(raw) ? (raw as string[]) : raw ? [String(raw)] : [];
  }

  const ctx = { applicantType: input.applicantType, selectedDepartmentCodes };

  const schema = buildApplicationSchema(sectionDefs, ctx);
  const parsed = schema.safeParse(input.answers);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) fieldErrors[String(issue.path[0] ?? "")] = issue.message;
    throw new SubmissionValidationError("Please fix the highlighted fields.", fieldErrors);
  }

  const needFiles = requiredFileKeys(sectionDefs, ctx);
  const missingFile = needFiles.find((k) => !input.files[k]);
  if (missingFile) throw new SubmissionValidationError("A required file is missing.", { [missingFile]: "required" });

  // Enforce upload rules: a file may only be uploaded under the key of a visible
  // FILE field. Rejecting unknown keys is also the primary defense against a
  // path-traversal write (the key is used to build the on-disk filename).
  const visibleFields = visibleSections(sectionDefs, ctx).flatMap((s) => s.fields);
  const allowedFileKeys = new Set(visibleFields.filter((f) => f.type === "FILE").map((f) => f.key));
  const maxMb = await getSetting<number>("uploads.maxMb");
  for (const [key, file] of Object.entries(input.files)) {
    if (!allowedFileKeys.has(key)) {
      throw new SubmissionValidationError("Unexpected file upload.", { [key]: "unknown field" });
    }
    const field = visibleFields.find((f) => f.key === key);
    const capMb = Math.min(field?.validation?.maxFileMB ?? maxMb, maxMb);
    if (file.bytes.length > capMb * 1024 * 1024) {
      throw new SubmissionValidationError(`File is too large (max ${capMb} MB).`, { [key]: `max ${capMb} MB` });
    }
    const accepted = field?.validation?.acceptedTypes;
    if (accepted && accepted.length > 0) {
      const name = file.fileName.toLowerCase();
      const mime = file.mimeType.toLowerCase();
      const ok = accepted.some((t) => {
        const tl = t.toLowerCase();
        return tl.startsWith(".") ? name.endsWith(tl) : mime === tl || (tl.endsWith("/*") && mime.startsWith(tl.slice(0, -1)));
      });
      if (!ok) {
        throw new SubmissionValidationError(`File type not allowed for this field.`, { [key]: `allowed: ${accepted.join(", ")}` });
      }
    }
  }

  const email = String(input.answers.email ?? "").trim();
  const emailLower = email.toLowerCase();
  const firstName = String(input.answers.first_name ?? "").trim();
  const lastName = String(input.answers.last_name ?? "").trim();

  const dup = await prisma.applicant.findUnique({ where: { cycleId_emailLower: { cycleId: cycle.id, emailLower } } });
  if (dup) throw new DuplicateApplicationError();

  const fileRefs = await persistFiles(cycle.id, input.files);
  const answersWithFiles = { ...parsed.data, ...fileRefs.answerPatch };

  let application: Application;
  try {
    application = await prisma.$transaction(async (tx) => {
      const applicant = await tx.applicant.create({
        data: { cycleId: cycle.id, firstName, lastName, email, emailLower, netId: typeof input.answers.netid === "string" ? input.answers.netid : null, phone: typeof input.answers.phone === "string" ? input.answers.phone : null },
      });
      const app = await tx.application.create({
        data: {
          cycleId: cycle.id, applicantId: applicant.id, answers: answersWithFiles as never,
          applicantType: input.applicantType, departmentChoices: selectedDepartmentCodes,
          renewalDepartment: input.applicantType === "RENEWAL" ? input.renewalDepartment! : null,
        },
      });
      await queueEmail(tx, {
        to: email,
        subject: `We received your ${cycle.title} application`,
        html: `<p>Hi ${escapeHtml(firstName) || "there"},</p><p>Thanks for applying to HAVEN Free Clinic. We have received your application and will be in touch.</p>`,
        template: "recruitment.application_received",
      });
      return app;
    });
  } catch (err) {
    if (typeof err === "object" && err && "code" in err && (err as { code?: string }).code === "P2002") {
      await cleanupFiles(fileRefs.storageKeys);
      throw new DuplicateApplicationError();
    }
    await cleanupFiles(fileRefs.storageKeys);
    throw err;
  }

  await recordAudit({ action: "recruitment.application_submit", entityType: "Application", entityId: application.id });
  return application;
}

async function persistFiles(cycleId: string, files: Record<string, UploadedFile>) {
  const answerPatch: Record<string, unknown> = {};
  const storageKeys: string[] = [];
  const entries = Object.entries(files);
  for (const [key, file] of entries) {
    // Sanitize both path components so a hostile field key or filename can never
    // escape the recruitment prefix; storage layer enforces a final backstop.
    const safeKey = key.replace(/[^a-z0-9_]/gi, "_");
    const safeExt = (path.extname(file.fileName).match(/^\.[A-Za-z0-9]{1,8}$/)?.[0]) ?? "";
    const storedName = `${safeKey}-${randomUUID()}${safeExt}`;
    const storageKey = `recruitment/${cycleId}/${storedName}`;
    await putObject(storageKey, file.bytes, file.mimeType);
    storageKeys.push(storageKey);
    answerPatch[key] = { storedName, fileName: file.fileName, mimeType: file.mimeType, size: file.bytes.length };
  }
  return { answerPatch, storageKeys };
}

async function cleanupFiles(storageKeys: string[]) {
  await Promise.all(storageKeys.map((k) => deleteObject(k)));
}

export async function listApplications(cycleId: string) {
  return prisma.application.findMany({
    where: { cycleId },
    include: { applicant: true },
    orderBy: { submittedAt: "desc" },
  });
}

export async function getApplication(id: string) {
  return prisma.application.findUnique({ where: { id }, include: { applicant: true, cycle: { include: { sections: { where: { purpose: "APPLICATION" }, include: { fields: { orderBy: { order: "asc" } } }, orderBy: { order: "asc" } } } } } });
}
