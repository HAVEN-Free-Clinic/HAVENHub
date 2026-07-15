import type { Application, FieldType } from "@prisma/client";
import { prisma, isUniqueConstraintError } from "@/platform/db";
import { getSetting } from "@/platform/settings/service";
import { queueEmail } from "@/platform/email/send";
import { persistFiles, cleanupFiles, validateUploadedFile, type UploadedFile } from "./upload";
export type { UploadedFile } from "./upload";
import { recordAudit } from "@/platform/audit";
import {
  buildApplicationSchema, requiredFileKeys,
  type SectionDef, type FieldDef,
} from "../engine/schema-builder";
import { visibleSections, type ApplicantType } from "../engine/visibility";
import { getRenewalContext } from "./renewal";
import { renderCycleEmail } from "../email/render";

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
  if ((input.applicantType === "RENEWAL" || input.applicantType === "TRANSFER") && !cycle.acceptsRenewals) {
    throw new CycleNotOpenError("This cycle does not accept returning applicants.");
  }

  let applicantPersonId: string | null = null;
  // The departments the renewing person currently belongs to, within this cycle.
  // A renewal can only be in one of these, so the department cannot be changed.
  let renewalAllowedDepartments: string[] = [];
  // For a TRANSFER: where the person is coming from (their active departments).
  let transferFromDepartments: string[] = [];
  // A returning applicant's identity comes from their matched record, not the
  // form: the identity section (first_name/last_name/net_id) is NEW-only, so it is
  // never rendered for them and their answers carry none of it. Capture it here.
  let returningIdentity: { name: string | null; netId: string | null; phone: string | null } | null = null;
  const isReturning = input.applicantType === "RENEWAL" || input.applicantType === "TRANSFER";
  if (isReturning) {
    const roleNoun = cycle.track === "DIRECTOR" ? "director" : "volunteer";
    if (!input.sessionPersonId || !input.sessionEmail) {
      throw new SubmissionValidationError(`Please sign in with Yale to apply as a returning ${roleNoun}.`);
    }
    const renewalCtx = await getRenewalContext(input.sessionPersonId, input.sessionEmail, cycle.track);
    if (!renewalCtx.eligible) {
      throw new SubmissionValidationError(`We do not see a current ${roleNoun} membership for your account.`);
    }
    applicantPersonId = renewalCtx.personId;
    returningIdentity = { name: renewalCtx.name, netId: renewalCtx.netId, phone: renewalCtx.phone };
    if (input.applicantType === "RENEWAL") {
      renewalAllowedDepartments = renewalCtx.currentDepartments.filter((d) => cycle.departments.includes(d));
    } else {
      // TRANSFER: the target department comes from the department-choice field,
      // like a new applicant; we only snapshot the origin for reviewer context.
      transferFromDepartments = renewalCtx.currentDepartments;
    }
    // Use the verified session email as the answer too, so schema validation
    // (and any EMAIL field) sees the authoritative value, not the client's.
    input.answers = { ...input.answers, email: input.sessionEmail };
  }

  if (input.applicantType === "NEW" && input.identityEmail) {
    // NEW applicants reach this service only through the identity-gated apply action
    // (submitPublicApplication rejects a null identity), so identityEmail is the
    // verified address (Yale SSO or magic-link). It is authoritative: the dedup +
    // owner key must be the verified identity, never the client form value, so an
    // attacker cannot submit under a victim's email or squat their dedup slot.
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
    if (input.applicantType === "TRANSFER") {
      // A transfer may not target a department the person already belongs to;
      // that is a renewal, not a transfer.
      const stayingPut = selectedDepartmentCodes.filter((d) => transferFromDepartments.includes(d));
      if (stayingPut.length > 0) {
        const key = deptField?.key ?? "renewalDepartment";
        throw new SubmissionValidationError(
          `You are already in ${stayingPut.join(", ")}. Choose "Renewing in my current department" to come back to it.`,
          { [key]: "already a member" },
        );
      }
    }
  }

  const ctx = { applicantType: input.applicantType, selectedDepartmentCodes };

  const schema = buildApplicationSchema(sectionDefs, ctx);
  const parsed = schema.safeParse(input.answers);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) fieldErrors[String(issue.path[0] ?? "")] = issue.message;
    throw new SubmissionValidationError("Please fix the highlighted fields.", fieldErrors);
  }

  // For returning applicants the email is the verified session address (also the dedup key);
  // the client-submitted value is ignored so it cannot be spoofed.
  const email = (isReturning ? input.sessionEmail! : String(input.answers.email ?? "")).trim();
  const emailLower = email.toLowerCase();
  // Returning applicants: split the matched record's name (the identity fields are
  // NEW-only, so answers.first_name/last_name are absent for them). New applicants:
  // read the form. The template key is net_id (snake_case, like first_name), not
  // "netid" -- reading answers.netid always yielded null, dropping every NetID.
  const returningName = (returningIdentity?.name ?? "").trim();
  const returningNameSplit = returningName.indexOf(" ");
  const firstName = (
    isReturning
      ? returningNameSplit === -1 ? returningName : returningName.slice(0, returningNameSplit)
      : String(input.answers.first_name ?? "")
  ).trim();
  const lastName = (
    isReturning
      ? returningNameSplit === -1 ? "" : returningName.slice(returningNameSplit + 1)
      : String(input.answers.last_name ?? "")
  ).trim();
  const identityNetId = isReturning
    ? returningIdentity?.netId ?? null
    : typeof input.answers.net_id === "string" ? input.answers.net_id : null;
  const identityPhone = isReturning
    ? returningIdentity?.phone ?? null
    : typeof input.answers.phone === "string" ? input.answers.phone : null;

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
    const problem = validateUploadedFile(file, field?.validation, maxMb);
    if (problem) throw new SubmissionValidationError(problem.message, { [key]: problem.detail });
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
          data: { applicantPersonId, firstName, lastName, email, emailLower, netId: identityNetId, phone: identityPhone },
        });
      } else {
        const created = await tx.applicant.create({
          data: { cycleId: cycle.id, applicantPersonId, firstName, lastName, email, emailLower, netId: identityNetId, phone: identityPhone },
        });
        applicantId = created.id;
      }
      const appData = {
        answers: answersWithFiles as never,
        applicantType: input.applicantType, departmentChoices: selectedDepartmentCodes, subcommitteeRanking,
        renewalDepartment: input.applicantType === "RENEWAL" ? input.renewalDepartment! : null,
        transferFromDepartments,
        status: "SUBMITTED" as const, submittedAt: new Date(),
      };
      let app: Application;
      if (existingApp) {
        // Claim the draft atomically: the status: "DRAFT" precondition means only
        // one of two concurrent submits can flip the row. Without it both would
        // flip DRAFT->SUBMITTED and queue a confirmation email, and the last
        // write's file refs would win, orphaning the loser's freshly-uploaded
        // blob (audit3 L9). Mirrors submitContract (onboarding.ts). The loser
        // throws DuplicateApplicationError, which the outer catch turns into a
        // cleanupFiles(fileRefs.storageKeys) so its new blob is dropped.
        const claimed = await tx.application.updateMany({ where: { id: existingApp.id, status: "DRAFT" }, data: appData });
        if (claimed.count === 0) throw new DuplicateApplicationError();
        app = await tx.application.findUniqueOrThrow({ where: { id: existingApp.id } });
      } else {
        app = await tx.application.create({ data: { cycleId: cycle.id, applicantId, ...appData } });
      }
      const receivedEmail = await renderCycleEmail(cycle.id, "recruitment.application_received", {
        firstName: firstName || "there",
        cycleTitle: cycle.title,
      });
      await queueEmail(tx, {
        to: email,
        subject: receivedEmail.subject,
        html: receivedEmail.html,
        template: "recruitment.application_received",
      });
      return app;
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      await cleanupFiles(fileRefs.storageKeys);
      throw new DuplicateApplicationError();
    }
    await cleanupFiles(fileRefs.storageKeys);
    throw err;
  }

  // The freshly-uploaded files replaced any draft file stored under the same
  // key; now that the submission has committed, delete those superseded draft
  // blobs so they don't linger orphaned in storage. (On failure the catch above
  // instead drops the new files and keeps the draft's blob.)
  const supersededKeys = Object.keys(fileRefs.answerPatch)
    .filter((k) => draftFileKeys.includes(k))
    .map((k) => `recruitment/${cycle.id}/${(draftAnswers[k] as { storedName: string }).storedName}`);
  if (supersededKeys.length > 0) await cleanupFiles(supersededKeys);

  await recordAudit({ action: "recruitment.application_submit", entityType: "Application", entityId: application.id });
  return application;
}

export async function getApplication(id: string) {
  return prisma.application.findUnique({ where: { id }, include: { applicant: true, cycle: { include: { sections: { where: { purpose: "APPLICATION" }, include: { fields: { orderBy: { order: "asc" } } }, orderBy: { order: "asc" } } } } } });
}
