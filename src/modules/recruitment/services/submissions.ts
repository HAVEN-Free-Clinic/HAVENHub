import type { Application, FieldType } from "@prisma/client";
import { prisma } from "@/platform/db";
import { getSetting } from "@/platform/settings/service";
import { queueEmail } from "@/platform/email/send";
import { persistFiles, cleanupFiles, type UploadedFile } from "./upload";
export type { UploadedFile } from "./upload";
import { recordAudit } from "@/platform/audit";
import {
  buildApplicationSchema, requiredFileKeys,
  type SectionDef, type FieldDef,
} from "../engine/schema-builder";
import { visibleSections, type ApplicantType } from "../engine/visibility";
import { getRenewalContext } from "./renewal";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export class CycleNotOpenError extends Error { constructor(m = "This application is closed.") { super(m); this.name = "CycleNotOpenError"; } }
export class DuplicateApplicationError extends Error { constructor(m = "You have already applied.") { super(m); this.name = "DuplicateApplicationError"; } }
export class SubmissionValidationError extends Error {
  fieldErrors: Record<string, string>;
  constructor(message: string, fieldErrors: Record<string, string> = {}) { super(message); this.name = "SubmissionValidationError"; this.fieldErrors = fieldErrors; }
}

export type SubmitInput = {
  applicantType: ApplicantType;
  renewalDepartment?: string;
  answers: Record<string, unknown>;
  files: Record<string, UploadedFile>;
  sessionPersonId?: string | null;
  sessionEmail?: string | null;
  identityEmail?: string | null;
};

const DEPT_CHOICE_KEY_TYPE: FieldType = "DEPARTMENT_CHOICE";
const SUBCOMMITTEE_RANK_TYPE: FieldType = "SUBCOMMITTEE_RANK";

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

/** Validate + normalize a ranking answer into ordered subcommittee IDs.
 *  Filters blanks (unfilled dropdowns submit ""), enforces distinct, known-active,
 *  and the field's rankCount cap; required means at least one. */
function resolveRanking(
  raw: unknown,
  required: boolean,
  rankCount: number,
  activeIds: Set<string>,
  fieldKey: string
): string[] {
  const list = (Array.isArray(raw) ? raw : raw == null || raw === "" ? [] : [raw])
    .map((v) => String(v))
    .filter((v) => v !== "");
  if (list.length === 0) {
    if (required) throw new SubmissionValidationError("Please rank at least one subcommittee.", { [fieldKey]: "required" });
    return [];
  }
  if (new Set(list).size !== list.length) {
    throw new SubmissionValidationError("Each subcommittee can be ranked only once.", { [fieldKey]: "duplicate choice" });
  }
  if (list.length > rankCount) {
    throw new SubmissionValidationError(`Rank at most ${rankCount} subcommittees.`, { [fieldKey]: `max ${rankCount}` });
  }
  for (const id of list) {
    if (!activeIds.has(id)) {
      throw new SubmissionValidationError("That subcommittee is not available.", { [fieldKey]: "unknown choice" });
    }
  }
  return list;
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

  // Renewals must be signed in and a current volunteer. The server re-verifies
  // here regardless of the client UI, and links the submission to the person.
  let applicantPersonId: string | null = null;
  // The departments the renewing person currently belongs to, within this cycle.
  // A renewal can only be in one of these, so the department cannot be changed.
  let renewalAllowedDepartments: string[] = [];
  if (input.applicantType === "RENEWAL") {
    const roleNoun = cycle.track === "DIRECTOR" ? "director" : "volunteer";
    if (!input.sessionPersonId || !input.sessionEmail) {
      throw new SubmissionValidationError(`Please sign in with Yale to apply as a returning ${roleNoun}.`);
    }
    const renewalCtx = await getRenewalContext(input.sessionPersonId, input.sessionEmail, cycle.track);
    if (!renewalCtx.eligible) {
      throw new SubmissionValidationError(`We do not see a current ${roleNoun} membership for your account.`);
    }
    applicantPersonId = renewalCtx.personId;
    renewalAllowedDepartments = renewalCtx.currentDepartments.filter((d) => cycle.departments.includes(d));
    // Use the verified session email as the answer too, so schema validation
    // (and any EMAIL field) sees the authoritative value, not the client's.
    input.answers = { ...input.answers, email: input.sessionEmail };
  }

  if (input.applicantType === "NEW" && input.identityEmail) {
    // The apply page is identity-gated; the authoritative email is the verified
    // identity (magic-link or SSO), not the form value. Override so the dedup +
    // owner key cannot be a different, unverified address.
    input.answers = { ...input.answers, email: input.identityEmail };
  }

  const sectionDefs = toSectionDefs(cycle.sections, cycle.departments, input.applicantType);

  let selectedDepartmentCodes: string[];
  if (input.applicantType === "RENEWAL") {
    // Authoritative check: the renewal department must be one the person actually
    // belongs to in this cycle, not just any cycle department. The client locks
    // this control, but the server is the source of truth.
    if (!input.renewalDepartment || !renewalAllowedDepartments.includes(input.renewalDepartment)) {
      throw new SubmissionValidationError("You can only renew in a department you currently belong to.", { renewalDepartment: "required" });
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

  // For renewals the email is the verified session address (also the dedup key);
  // the client-submitted value is ignored so it cannot be spoofed.
  const email = (input.applicantType === "RENEWAL" ? input.sessionEmail! : String(input.answers.email ?? "")).trim();
  const emailLower = email.toLowerCase();
  const firstName = String(input.answers.first_name ?? "").trim();
  const lastName = String(input.answers.last_name ?? "").trim();

  const existingApplicant = await prisma.applicant.findUnique({
    where: { cycleId_emailLower: { cycleId: cycle.id, emailLower } },
    include: { applications: true },
  });
  const existingApp = existingApplicant?.applications[0];
  if (existingApp && existingApp.status === "SUBMITTED") throw new DuplicateApplicationError();
  // Files uploaded during the draft live in the draft answers as refs; treat
  // them as already-present so a resumed applicant need not re-pick them.
  const draftAnswers = (existingApp?.answers as Record<string, unknown>) ?? {};
  const draftFileKeys = Object.keys(draftAnswers).filter((k) => {
    const v = draftAnswers[k];
    return v != null && typeof v === "object" && "storedName" in (v as object);
  });

  const needFiles = requiredFileKeys(sectionDefs, ctx);
  const missingFile = needFiles.find((k) => !input.files[k] && !draftFileKeys.includes(k));
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

  // Subcommittee ranking: hoisted into its own column like departmentChoices, and
  // intentionally kept out of stored answers (single source of truth = the column).
  const rankField = cycle.sections.flatMap((s) => s.fields).find((f) => f.type === SUBCOMMITTEE_RANK_TYPE);
  let subcommitteeRanking: string[] = [];
  if (rankField) {
    const activeSubs = await prisma.subcommittee.findMany({ where: { isActive: true }, select: { id: true } });
    const activeIds = new Set(activeSubs.map((s) => s.id));
    const rankCount = (rankField.validation as { rankCount?: number } | null)?.rankCount ?? 3;
    subcommitteeRanking = resolveRanking(input.answers[rankField.key], rankField.required, rankCount, activeIds, rankField.key);
  }

  const fileRefs = await persistFiles(cycle.id, input.files);
  const draftFileRefs = Object.fromEntries(draftFileKeys.map((k) => [k, draftAnswers[k]]));
  const answersWithFiles = { ...draftFileRefs, ...parsed.data, ...fileRefs.answerPatch };
  if (rankField) delete (answersWithFiles as Record<string, unknown>)[rankField.key];

  let application: Application;
  try {
    application = await prisma.$transaction(async (tx) => {
      let applicantId = existingApplicant?.id;
      if (applicantId) {
        // Finalize the existing draft applicant: fill in identity fields from answers.
        await tx.applicant.update({
          where: { id: applicantId },
          data: { applicantPersonId, firstName, lastName, email, emailLower, netId: typeof input.answers.netid === "string" ? input.answers.netid : null, phone: typeof input.answers.phone === "string" ? input.answers.phone : null },
        });
      } else {
        const created = await tx.applicant.create({
          data: { cycleId: cycle.id, applicantPersonId, firstName, lastName, email, emailLower, netId: typeof input.answers.netid === "string" ? input.answers.netid : null, phone: typeof input.answers.phone === "string" ? input.answers.phone : null },
        });
        applicantId = created.id;
      }
      const appData = {
        answers: answersWithFiles as never,
        applicantType: input.applicantType, departmentChoices: selectedDepartmentCodes, subcommitteeRanking,
        renewalDepartment: input.applicantType === "RENEWAL" ? input.renewalDepartment! : null,
        status: "SUBMITTED" as const, submittedAt: new Date(),
      };
      const app = existingApp
        ? await tx.application.update({ where: { id: existingApp.id }, data: appData })
        : await tx.application.create({ data: { cycleId: cycle.id, applicantId, ...appData } });
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
