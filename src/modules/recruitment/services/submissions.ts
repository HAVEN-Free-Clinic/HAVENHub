import { randomUUID } from "node:crypto";
import type { Application, FieldType } from "@prisma/client";
import { prisma, isUniqueConstraintError } from "@/platform/db";
import { getSetting } from "@/platform/settings/service";
import { queueEmail } from "@/platform/email/send";
import { putObject } from "@/platform/storage";
import { persistFiles, cleanupFiles, validateUploadedFile, type UploadedFile } from "./upload";
export type { UploadedFile } from "./upload";
import { recordAudit } from "@/platform/audit";
import {
  buildApplicationSchema, requiredFileKeys,
  type SectionDef, type FieldDef,
} from "../engine/schema-builder";
import { visibleSections, type ApplicantType } from "../engine/visibility";
import { isFieldVisible, mergeDepartmentAnswer, answersForConditions } from "../engine/field-visibility";
import { getRenewalContext } from "./renewal";
import { renderCycleEmail } from "../email/render";
import { decodeSignaturePng, SignatureError } from "./signature";
import { resolveAvailabilityOptions, AVAILABILITY_FIELD_KEY } from "../templates/clinic-dates";

export class CycleNotOpenError extends Error { constructor(m = "This application is closed.") { super(m); this.name = "CycleNotOpenError"; } }
export class DuplicateApplicationError extends Error { constructor(m = "You have already applied.") { super(m); this.name = "DuplicateApplicationError"; } }
export class SubmissionValidationError extends Error {
  fieldErrors: Record<string, string>;
  constructor(message: string, fieldErrors: Record<string, string> = {}) { super(message); this.name = "SubmissionValidationError"; this.fieldErrors = fieldErrors; }
}

/** The apply wizard renders `message` as the banner above the form and each
 *  `fieldErrors` value verbatim as the red text under its field (field-preview).
 *  So a field error must be the readable sentence, and the banner stays generic --
 *  otherwise the applicant reads the complaint twice, the second time as an
 *  internal code ("duplicate choice"). Schema validation already works this way. */
const FIX_HIGHLIGHTED = "Please fix the highlighted fields.";

function fieldProblem(fieldKey: string, message: string): SubmissionValidationError {
  return new SubmissionValidationError(FIX_HIGHLIGHTED, { [fieldKey]: message });
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
  sections: { id: string; appliesTo: SectionDef["appliesTo"]; departmentCode: string | null; fields: { key: string; type: FieldType; required: boolean; options: unknown; validation: unknown; visibleWhen: unknown }[] }[],
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
      visibleWhen: f.visibleWhen ?? null,
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
    if (required) throw fieldProblem(fieldKey, "Please rank at least one subcommittee.");
    return [];
  }
  if (new Set(list).size !== list.length) {
    throw fieldProblem(fieldKey, "Each subcommittee can be ranked only once.");
  }
  if (list.length > rankCount) {
    throw fieldProblem(fieldKey, `Rank at most ${rankCount} subcommittees.`);
  }
  for (const id of list) {
    if (!activeIds.has(id)) {
      throw fieldProblem(fieldKey, "That subcommittee is not available.");
    }
  }
  return list;
}

export async function submitApplication(slug: string, input: SubmitInput): Promise<Application> {
  const cycle = await prisma.recruitmentCycle.findUnique({
    where: { publicSlug: slug },
    include: {
      term: { select: { clinicDates: true } },
      sections: { where: { purpose: "APPLICATION" }, include: { fields: { orderBy: { order: "asc" } } }, orderBy: { order: "asc" } },
    },
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

  // A NEW applicant who is nonetheless a matched person (signed in with an
  // existing record) cannot change their NetID -- pin it to the record, the same
  // authority principle as the verified email above. Returning applicants already
  // take their NetID from the record (below); unmatched applicants (no
  // sessionPersonId) and records without a NetID keep the form value.
  let matchedRecordNetId: string | null = null;
  if (!isReturning && input.sessionPersonId) {
    const rec = await prisma.person.findUnique({ where: { id: input.sessionPersonId }, select: { netId: true } });
    matchedRecordNetId = rec?.netId ?? null;
    // Link a NEW application to its submitter's Person record too, not just a
    // returning one. Every separation-of-duties guard in recruitment keys on
    // applicantPersonId (committee-scoring.ts:33, routing.ts:116/179,
    // interview-decisions.ts:25, evaluations.ts:21, and the "never queue your
    // own application" filter), and each short-circuits on the `&&` truthiness
    // test when it is null. Leaving it unset let a sitting director pick "New
    // applicant" in the wizard and then score and accept their own application.
    // saveDraft already stores this link (drafts.ts:135); without this the
    // finalisation update below erased it.
    applicantPersonId = input.sessionPersonId;
  }

  const resolvedSections = resolveAvailabilityOptions(cycle.sections, cycle.term.clinicDates);
  const sectionDefs = toSectionDefs(resolvedSections, cycle.departments, input.applicantType);

  let selectedDepartmentCodes: string[];
  if (input.applicantType === "RENEWAL") {
    // Authoritative check: the renewal department must be one the person actually
    // belongs to in this cycle, not just any cycle department. The client locks
    // this control, but the server is the source of truth.
    if (!input.renewalDepartment || !renewalAllowedDepartments.includes(input.renewalDepartment)) {
      throw fieldProblem("renewalDepartment", "You can only renew in a department you currently belong to.");
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
        throw fieldProblem(
          key,
          `You are already in ${stayingPut.join(", ")}. Choose "Renewing in my current department" to come back to it.`,
        );
      }
    }
  }

  // Resolve the dedup identity and any resumed-draft file refs BEFORE building the
  // visibility context. A FILE field can gate other fields, but its "answer" lives
  // out of band -- in this submit's uploads (input.files) or in a prior draft's
  // stored refs (draftFileKeys) -- never in input.answers. Marking those keys
  // present lets a condition keyed on a FILE evaluate here exactly as the wizard
  // rendered it, instead of always resolving to unanswered (which silently dropped
  // dependent answers, or hard-blocked a field the applicant was shown).
  const email = (isReturning ? input.sessionEmail! : String(input.answers.email ?? "")).trim();
  const emailLower = email.toLowerCase();
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

  // answersForConditions normalizes a CHECKBOX ("on"/"") and a file/signature ref
  // ("attached"), and the file-key markers cover the out-of-band uploads above, so
  // this map matches what the wizard evaluated. mergeDepartmentAnswer then supplies
  // the authoritative department under the DEPARTMENT_CHOICE key, which a RENEWAL
  // never submits, so a department-gated condition sees the real selection.
  const deptChoiceKey = resolvedSections.flatMap((s) => s.fields).find((f) => f.type === DEPT_CHOICE_KEY_TYPE)?.key;
  const answersForVisibility = mergeDepartmentAnswer(
    answersForConditions(input.answers as Record<string, unknown>, [...Object.keys(input.files), ...draftFileKeys]),
    deptChoiceKey,
    selectedDepartmentCodes,
  ) as Record<string, string | string[] | undefined>;
  const ctx = { applicantType: input.applicantType, selectedDepartmentCodes, answers: answersForVisibility };

  // The availability options are live (they track Term.clinicDates), so a date
  // the admin removed between a saved draft and this submit is no longer in the
  // enum, and no longer rendered either. Rejecting would strand the applicant on
  // a checkbox they cannot see or clear, so drop unknown values instead. If that
  // empties a required answer they get the normal "required" error against the
  // refreshed list, which they can act on.
  const availabilityField = resolvedSections
    .flatMap((s) => s.fields)
    .find((f) => f.key === AVAILABILITY_FIELD_KEY);
  if (availabilityField) {
    const live = new Set(
      ((availabilityField.options ?? []) as { value: string }[]).map((o) => o.value),
    );
    const answered = (input.answers as Record<string, unknown>)[AVAILABILITY_FIELD_KEY];
    if (answered != null && answered !== "") {
      const list = Array.isArray(answered) ? answered : [answered];
      (input.answers as Record<string, unknown>)[AVAILABILITY_FIELD_KEY] =
        list.filter((v) => typeof v === "string" && live.has(v));
    }
  }

  const schema = buildApplicationSchema(sectionDefs, ctx);
  const parsed = schema.safeParse(input.answers);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) fieldErrors[String(issue.path[0] ?? "")] = issue.message;
    throw new SubmissionValidationError("Please fix the highlighted fields.", fieldErrors);
  }

  // email/emailLower and the existing-applicant + draft-file lookup are resolved
  // above (needed to build the visibility context). For returning applicants the
  // email is the verified session address; the client value is ignored.
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
    : matchedRecordNetId ?? (typeof input.answers.net_id === "string" ? input.answers.net_id : null);
  const identityPhone = isReturning
    ? returningIdentity?.phone ?? null
    : typeof input.answers.phone === "string" ? input.answers.phone : null;

  const needFiles = requiredFileKeys(sectionDefs, ctx);
  const missingFile = needFiles.find((k) => !input.files[k] && !draftFileKeys.includes(k));
  if (missingFile) throw fieldProblem(missingFile, "Please attach a file.");

  // Enforce upload rules: a file may only be uploaded under the key of a visible
  // FILE field. Rejecting unknown keys is also the primary defense against a
  // path-traversal write (the key is used to build the on-disk filename).
  //
  // A FILE field can itself be condition-hidden (`visibleWhen`), same as any other
  // field. Its section being visible is not enough -- the field's own condition
  // must also hold, or its file is dropped here (never handed to persistFiles, so
  // no blob is ever written for it) instead of being rejected as "unknown field".
  // This mirrors how a hidden scalar field's answer is silently excluded rather
  // than treated as an error, and closes the orphaned-blob gap a hidden file
  // input can otherwise open (DOM unmounting of hidden fields is a later task, so
  // a hidden file input can still submit its FormData entry today).
  const visibleFields = visibleSections(sectionDefs, ctx).flatMap((s) => s.fields);
  const fileFields = visibleFields.filter((f) => f.type === "FILE");
  const maxMb = await getSetting<number>("uploads.maxMb");
  const filesToPersist: Record<string, UploadedFile> = {};
  for (const [key, file] of Object.entries(input.files)) {
    const field = fileFields.find((f) => f.key === key);
    if (!field) {
      // No field error: `key` names no field the applicant can see, so there is
      // nothing to highlight -- only the banner can carry this one.
      throw new SubmissionValidationError("Unexpected file upload.");
    }
    if (!isFieldVisible(field.visibleWhen, ctx.answers)) continue; // condition-hidden: silently skip, not persisted
    const problem = validateUploadedFile(file, field.validation, maxMb);
    if (problem) throw new SubmissionValidationError(problem.message, { [key]: problem.detail });
    filesToPersist[key] = file;
  }

  // Subcommittee ranking: hoisted into its own column like departmentChoices, and
  // intentionally kept out of stored answers (single source of truth = the column).
  // Pick the rank field off the VISIBLE sections + its own visibleWhen, the same
  // way every other required field is scoped (#56). Scanning cycle.sections
  // regardless of applicant-type/department scope meant a rank field the applicant
  // could never see was still required at submit -- dead-ending, e.g., every
  // renewing director when the rank section is scoped NEW-only, with an error that
  // maps to no rendered step.
  const rankField = visibleFields.find(
    (f) => f.type === SUBCOMMITTEE_RANK_TYPE && isFieldVisible(f.visibleWhen, ctx.answers),
  );
  let subcommitteeRanking: string[] = [];
  if (rankField) {
    const activeSubs = await prisma.subcommittee.findMany({ where: { isActive: true }, select: { id: true } });
    const activeIds = new Set(activeSubs.map((s) => s.id));
    const rankCount = (rankField.validation as { rankCount?: number } | null)?.rankCount ?? 3;
    subcommitteeRanking = resolveRanking(input.answers[rankField.key], rankField.required, rankCount, activeIds, rankField.key);
  }

  const fileRefs = await persistFiles(cycle.id, filesToPersist);
  const draftFileRefs = Object.fromEntries(draftFileKeys.map((k) => [k, draftAnswers[k]]));
  const answersWithFiles = { ...draftFileRefs, ...parsed.data, ...fileRefs.answerPatch };
  if (rankField) delete (answersWithFiles as Record<string, unknown>)[rankField.key];
  // Strip any condition-hidden field's stale answer (e.g. the applicant answered
  // it, then flipped the gate that hides it) so persisted answers only ever
  // reflect what was actually visible at submission time. A stripped FILE field
  // can carry an existing DRAFT-uploaded blob under this same key (uploaded back
  // when the field was still visible); without deleting that blob too, its
  // answer key is gone from `answers` but the file lingers orphaned in storage.
  const orphanedDraftFileKeys: string[] = [];
  for (const field of visibleFields) {
    if (!isFieldVisible(field.visibleWhen, ctx.answers)) {
      delete (answersWithFiles as Record<string, unknown>)[field.key];
      if (field.type === "FILE" && draftFileKeys.includes(field.key)) {
        orphanedDraftFileKeys.push(`recruitment/${cycle.id}/${(draftAnswers[field.key] as { storedName: string }).storedName}`);
      }
    }
  }

  // Declared out here so the outer catch below can clean up any signature blobs
  // written before a failure (mirrors fileRefs.storageKeys).
  const signatureStorageKeys: string[] = [];
  let application: Application;
  try {
    // Drawn signatures: each SIGNATURE answer arrived as a PNG data URL. Store it as
    // a private blob (like FILE) and replace the answer with a file-ref carrying the
    // audit context (method + printed name + server-stamped signedAt). Companion
    // keys (`${key}__method` / `${key}__name`) live only in the raw input.answers;
    // the zod object stripped them, so they never reach answersWithFiles.
    //
    // This loop runs INSIDE the try so a putObject failure -- or a decode-failure on a
    // payload that passed zod's prefix check but fails the PNG magic-byte check -- is
    // caught below and cleans up the already-persisted FILE blobs (which can be PII)
    // plus any signature blobs written in earlier iterations, instead of escaping and
    // orphaning them. The onboarding contract path (onboarding.ts) does the same.
    for (const field of visibleFields) {
      if (field.type !== "SIGNATURE") continue;
      if (!isFieldVisible(field.visibleWhen, ctx.answers)) continue;
      const raw = (answersWithFiles as Record<string, unknown>)[field.key];
      if (typeof raw !== "string" || raw === "") { delete (answersWithFiles as Record<string, unknown>)[field.key]; continue; }
      let bytes: Buffer;
      try {
        bytes = decodeSignaturePng(raw);
      } catch (err) {
        // Rethrows as SubmissionValidationError, now caught by the outer catch ->
        // cleanup -> rethrow, so the caller still receives the validation error.
        if (err instanceof SignatureError) throw fieldProblem(field.key, "Please provide a valid signature.");
        throw err;
      }
      const safeKey = field.key.replace(/[^a-z0-9_]/gi, "_");
      const storedName = `${safeKey}-${randomUUID()}.png`;
      const storageKey = `recruitment/${cycle.id}/${storedName}`;
      await putObject(storageKey, bytes, "image/png");
      signatureStorageKeys.push(storageKey);
      const rawMethod = input.answers[`${field.key}__method`];
      const rawName = input.answers[`${field.key}__name`];
      const method: "type" | "draw" = rawMethod === "type" ? "type" : "draw";
      const typedName = typeof rawName === "string" ? rawName.trim() : "";
      // Printed name for the audit trail. A typed signature carries its own name;
      // a drawn signature's companion field is only a best-effort client hint
      // (blank for a new applicant, since the pad has no live name), so fall back
      // to the authoritative identity name resolved above.
      const signerName = method === "type" ? typedName : (`${firstName} ${lastName}`.trim() || typedName);
      (answersWithFiles as Record<string, unknown>)[field.key] = {
        storedName,
        fileName: "signature.png",
        mimeType: "image/png",
        size: bytes.length,
        method,
        name: signerName,
        signedAt: new Date().toISOString(),
      };
    }

    application = await prisma.$transaction(async (tx) => {
      let applicantId = existingApplicant?.id;
      if (applicantId) {
        // Finalize the existing draft applicant: fill in identity fields from answers.
        await tx.applicant.update({
          where: { id: applicantId },
          data: {
            // Never downgrade a link the draft already established: erasing it
            // would silently disable the self-dealing guards that key on it.
            applicantPersonId: applicantPersonId ?? existingApplicant?.applicantPersonId ?? null,
            firstName, lastName, email, emailLower, netId: identityNetId, phone: identityPhone,
          },
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
        // Returning members (RENEWAL only, NOT TRANSFER) skip committee scoring +
        // routing: auto-route them straight to their current department so its
        // director sees and decides them directly. Routing is volunteer-only (the
        // director track is ranking-based and already visible to the dept). A
        // TRANSFER is treated like a NEW applicant and goes through the committee.
        ...(input.applicantType === "RENEWAL" && cycle.track === "VOLUNTEER"
          ? { routedDepartmentCode: input.renewalDepartment!, routedAt: new Date() }
          : {}),
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
      await cleanupFiles([...fileRefs.storageKeys, ...signatureStorageKeys]);
      throw new DuplicateApplicationError();
    }
    await cleanupFiles([...fileRefs.storageKeys, ...signatureStorageKeys]);
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
  // Same idea for a FILE field's draft blob orphaned by a visibility condition
  // (see the strip loop above): now that the submission has committed, it's
  // safe to delete.
  if (orphanedDraftFileKeys.length > 0) await cleanupFiles(orphanedDraftFileKeys);

  await recordAudit({ action: "recruitment.application_submit", entityType: "Application", entityId: application.id });
  return application;
}

export async function getApplication(id: string) {
  const application = await prisma.application.findUnique({
    where: { id },
    include: {
      applicant: true,
      cycle: {
        include: {
          term: { select: { clinicDates: true } },
          sections: { where: { purpose: "APPLICATION" }, include: { fields: { orderBy: { order: "asc" } } }, orderBy: { order: "asc" } },
        },
      },
    },
  });
  if (!application) return null;
  // The reviewer view resolves option labels off these sections (speed-score.ts
  // labelFor), and falls back to the raw value for an option that is gone, so a
  // date removed after submission degrades to "2026-06-13" rather than breaking.
  return {
    ...application,
    cycle: { ...application.cycle, sections: resolveAvailabilityOptions(application.cycle.sections, application.cycle.term.clinicDates) },
  };
}
