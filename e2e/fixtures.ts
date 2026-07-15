import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import { expect, type Locator, type Page } from "@playwright/test";

/** Playwright does not auto-load .env; read DATABASE_URL from env with a .env fallback. */
function databaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const env = readFileSync(".env", "utf8");
  const m = env.match(/^DATABASE_URL=['"]?([^'"\n]+)/m);
  if (!m) throw new Error("DATABASE_URL not found in process.env or .env");
  return m[1];
}

/** e2e-only client; NOT the app's server-only singleton. */
export const prisma = new PrismaClient({
  datasources: { db: { url: databaseUrl() } },
});

const DAY = 24 * 60 * 60 * 1000;
const daysFromNow = (n: number) => new Date(Date.now() + n * DAY);

/** Unique, greppable suffix so live-DB rows never collide. */
export function tag(): string {
  return `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

async function activeTerm() {
  return prisma.term.findFirstOrThrow({ where: { status: "ACTIVE" } });
}
async function dept(code: string) {
  return prisma.department.findUniqueOrThrow({ where: { code } });
}

/** Remove a person and every row that references it (run before the person delete). */
export async function cleanupPerson(personId: string): Promise<void> {
  // Remove shift-level data first (FK deps before membership/person delete).
  // ShiftRequest has no personId: a person appears as requesterId (cascades), targetId
  // (SetNull), or decidedById (Restrict). Clear requester/target rows explicitly so
  // cleanup is deterministic; fixture members never decide requests, so decidedById is moot.
  await prisma.shiftRequest.deleteMany({ where: { OR: [{ requesterId: personId }, { targetId: personId }] } });
  await prisma.shiftAssignment.deleteMany({ where: { personId } });
  await prisma.hipaaCertificate.deleteMany({ where: { personId } });
  await prisma.notification.deleteMany({ where: { personId } });
  await prisma.termMembership.deleteMany({ where: { personId } });
  await prisma.person.delete({ where: { id: personId } }).catch((e) => console.warn("[e2e cleanup] delete failed, row may be leaked:", e instanceof Error ? e.message : e));
}

export async function seedComplianceMember(
  deptCode: string,
  opts: {
    status?: "COMPLIANT" | "EXPIRING_SOON" | "EXPIRED" | "DATE_UNKNOWN";
    kind?: "VOLUNTEER" | "DIRECTOR";
  } = {}
) {
  const status = opts.status ?? "COMPLIANT";
  const kind = opts.kind ?? "VOLUNTEER";
  const term = await activeTerm();
  const department = await dept(deptCode);
  const t = tag();
  const person = await prisma.person.create({
    data: { name: `E2E Member ${t}`, contactEmail: `${t}@example.test` },
  });
  await prisma.termMembership.create({
    data: { personId: person.id, termId: term.id, departmentId: department.id, kind, status: "ACTIVE" },
  });
  // Cert validity is completionDate + 365d. Offsets chosen to land in each status bucket.
  // Final offsets are tuned during the task against src/modules/volunteers/services/compliance.ts.
  const completion: Record<string, Date | null> = {
    COMPLIANT: daysFromNow(-10),
    EXPIRING_SOON: daysFromNow(-340),
    EXPIRED: daysFromNow(-400),
    DATE_UNKNOWN: null,
  };
  await prisma.hipaaCertificate.create({
    data: {
      personId: person.id,
      fileName: "e2e.pdf",
      storedName: `${t}.pdf`,
      size: 100,
      mimeType: "application/pdf",
      completionDate: completion[status],
      verifiedAt: new Date(), // verified so the status actually gates
    },
  });
  return { person, cleanup: () => cleanupPerson(person.id) };
}

export async function seedNotification(
  personId: string,
  opts: { type?: string; title?: string; body?: string; link?: string } = {}
) {
  const t = tag();
  const row = await prisma.notification.create({
    data: {
      personId,
      type: opts.type ?? "e2e",
      title: opts.title ?? `E2E notice ${t}`,
      body: opts.body ?? "An end-to-end test notification.",
      link: opts.link ?? null,
    },
  });
  return {
    id: row.id,
    cleanup: () => prisma.notification.delete({ where: { id: row.id } }).then(() => {}).catch((e) => console.warn("[e2e cleanup] delete failed, row may be leaked:", e instanceof Error ? e.message : e)),
  };
}

export async function seedCourseWithPackage(
  opts: { title?: string; deptCode?: string } = {}
) {
  const t = tag();
  // Scope to one department (not assignToAll). An org-wide packaged course is
  // auto-assigned to every member (coursesForMember), which would briefly gate
  // dev.volunteer/dev.director on the onboarding learning task and flake the
  // login-based specs. The admin (Jack, ITCM director) is still assigned via the dept.
  const department = await dept(opts.deptCode ?? "ITCM");
  const course = await prisma.course.create({
    data: {
      title: opts.title ?? `E2E Course ${t}`,
      isActive: true,
      assignToAll: false,
      // Marks the course as having an ingested package so it is assignable/openable.
      scormEntryHref: "index.html",
      scormVersion: "1.2",
      scormUploadedAt: new Date(),
      departments: { create: [{ departmentId: department.id }] },
    },
  });
  return {
    course,
    cleanup: () =>
      prisma.course.delete({ where: { id: course.id } }).then(() => {}).catch((e) => console.warn("[e2e cleanup] delete failed, row may be leaked:", e instanceof Error ? e.message : e)),
  };
}

export async function seedRhdAttending(
  opts: { scheduleName?: string; fullName?: string } = {}
) {
  const t = tag();
  const attending = await prisma.rhdAttending.create({
    data: {
      scheduleName: opts.scheduleName ?? `E2E Attending ${t}`,
      fullName: opts.fullName ?? `E2E Attending ${t}`,
      isActive: true,
    },
  });
  return {
    attending,
    cleanup: () =>
      prisma.rhdAttending.delete({ where: { id: attending.id } }).then(() => {}).catch((e) => console.warn("[e2e cleanup] delete failed, row may be leaked:", e instanceof Error ? e.message : e)),
  };
}

/**
 * Temporarily sets `idealHeadcount` and/or `patientCapacityPerProvider` on a
 * department so the capacity panel renders in the builder. Restores the
 * previous values on cleanup, making the fixture safe against both bare-seed
 * CI (where the fields are null) and environments where they are already set.
 */
/**
 * Seed an uncleared volunteer: ACTIVE person with a @yale.edu contactEmail
 * (so dev login resolves them via the Yale-email step in resolvePersonForLogin)
 * and an ACTIVE VADM TermMembership. No phone, no HIPAA cert, no training, no
 * learning progress -- so the onboarding gate keeps them on /get-started.
 *
 * Person.status defaults to ACTIVE in the schema; no explicit field needed.
 */
export async function seedUnclearedVolunteer() {
  const t = tag();
  const term = await activeTerm();
  const department = await dept("VADM");
  const person = await prisma.person.create({
    data: { name: `E2E Uncleared ${t}`, contactEmail: `uncleared-${t}@yale.edu` },
  });
  await prisma.termMembership.create({
    data: { personId: person.id, termId: term.id, departmentId: department.id, kind: "VOLUNTEER", status: "ACTIVE" },
  });
  return { person, cleanup: () => cleanupPerson(person.id) };
}

export async function seedCapacityConfig(
  deptCode: string,
  quota: { idealHeadcount?: number | null; patientCapacityPerProvider?: number | null }
) {
  const department = await prisma.department.findUniqueOrThrow({ where: { code: deptCode } });
  const before = {
    idealHeadcount: department.idealHeadcount,
    patientCapacityPerProvider: department.patientCapacityPerProvider,
  };
  await prisma.department.update({
    where: { id: department.id },
    data: {
      idealHeadcount: quota.idealHeadcount ?? null,
      patientCapacityPerProvider: quota.patientCapacityPerProvider ?? null,
    },
  });
  return {
    cleanup: async () => {
      await prisma.department.update({
        where: { id: department.id },
        data: { idealHeadcount: before.idealHeadcount, patientCapacityPerProvider: before.patientCapacityPerProvider },
      }).catch((e) => console.warn("[e2e cleanup] capacity reset failed:", e instanceof Error ? e.message : e));
    },
  };
}

/**
 * The director track's "Subcommittee preference" step (subcommitteeSection in
 * templates/field-groups.ts) needs at least one active Subcommittee row to
 * offer a selectable option -- dev/e2e DBs seed none (prisma/seed.ts has no
 * Subcommittee rows). Idempotent: reuses any existing active row rather than
 * accumulating one per test run, mirroring the Department/Term catalog rows
 * that fixtures reuse rather than create-and-clean-up.
 */
async function ensureSubcommittee(): Promise<void> {
  const existing = await prisma.subcommittee.findFirst({ where: { isActive: true } });
  if (existing) return;
  await prisma.subcommittee.create({ data: { name: "E2E Subcommittee" } });
}

/** Selects the first non-placeholder <option> of a <select>, if any. Used for
 *  SUBCOMMITTEE_RANK (field-preview.tsx), whose options are live Subcommittee
 *  ids/names unknown ahead of time. Returns false (no-op) if the select has
 *  no real option yet. */
async function selectFirstRealOption(select: Locator): Promise<boolean> {
  const value = await select.locator('option:not([value=""])').first().getAttribute("value").catch(() => null);
  if (!value) return false;
  await select.selectOption(value);
  return true;
}

const DUMMY_FILE_BYTES = Buffer.from("%PDF-1.4\n% e2e placeholder file\n");

/**
 * Attaches a small dummy PDF to a required FILE field (field-preview.tsx's
 * FILE case renders `<input type="file" name={f.key}>`), then waits for the
 * wizard's own "Attached: <name>" status line (apply-wizard.tsx's
 * handleFileChange uploads the draft file asynchronously via
 * uploadDraftFileAction) before returning, so the caller's next "Continue"
 * click sees the field as answered. No-ops if the field is not on the
 * currently visible step, or is already attached.
 */
async function attachDummyFile(applyPage: Page, key: string): Promise<void> {
  const input = applyPage.locator(`input[name="${key}"][type="file"]`);
  if (!(await input.isVisible().catch(() => false))) return;
  // The wrapping <div key={f.key} onChange=...> in apply-wizard.tsx is the
  // closest div ancestor of the file input (FieldPreview's FILE case renders
  // only a <label>, no nested divs) and also holds the "Attached:" status
  // line as a sibling, so it is the right scope for both the pre-check below
  // and the post-upload wait.
  const wrapper = applyPage.locator("div").filter({ has: input }).last();
  if (await wrapper.getByText(/^Attached:/).isVisible().catch(() => false)) return;
  // uploadDraftFileAction (draft-actions.ts) requires an already-existing,
  // non-submitted draft Application row (drafts.ts's uploadDraftFile throws
  // "No editable draft." otherwise); that row is only created by the
  // debounced answers autosave (apply-wizard.tsx's scheduleSave, 800ms after
  // the form's last change event). This helper's earlier field fills on the
  // current step happen faster than that debounce, so wait for the "Saved"
  // status line to confirm the row exists before uploading.
  await expect(applyPage.getByText("Saved", { exact: true })).toBeVisible({ timeout: 10_000 });
  await input.setInputFiles({ name: `${key}.pdf`, mimeType: "application/pdf", buffer: DUMMY_FILE_BYTES });
  await expect(wrapper.getByText(/^Attached:/)).toBeVisible({ timeout: 15_000 });
}

export type FillDefaultApplicationOptions = {
  /** Must match the verified applicant identity (the forged applicant_session
   *  cookie's email, or the signed-in session's email) -- submitPublicApplication
   *  binds the application to that identity, not to this field's text value. */
  email: string;
  /** Must be one of the cycle's `departments` (an exact, case-sensitive match --
   *  the DEPARTMENT_CHOICE <select>'s options are literally `cycle.departments`,
   *  see src/app/apply/[slug]/page.tsx). Pick a code with no department
   *  supplement section for the cycle's track (see SUPPLEMENT_DEPARTMENTS in
   *  templates/application/supplements/dept-codes.ts) to keep the flow to just
   *  the shared default-template steps. */
  department: string;
  firstName?: string;
  lastName?: string;
  netId?: string;
  phone?: string;
  /** Value from templates/content/options.ts YALE_AFFILIATION; default keeps
   *  the conditional "yale_affiliation_other" field hidden. */
  yaleAffiliation?: string;
  gradYear?: string;
  /** Safety bound on the Continue-click loop. The richest current track (either
   *  VOLUNTEER or DIRECTOR) is 8 section steps + Review = 9; default gives
   *  headroom for a department supplement section too. */
  maxSteps?: number;
};

/**
 * Walks the default recruitment application wizard (src/app/apply/[slug]/apply-wizard.tsx)
 * end to end for either track, filling each visible step's known fields, then
 * clicking "Continue" until the Review step's "Submit application" button
 * appears, submitting, and asserting the confirmation message.
 *
 * Only the current step is mounted visibly (apply-wizard.tsx keeps every
 * visible section's DOM mounted but CSS-hidden, so its uncontrolled fields
 * stay in the form), so this re-checks visibility every iteration rather than
 * filling everything once up front.
 *
 * Conditional follow-up questions (yale_affiliation_other, medical_certifications,
 * medical_details, other_languages_detail -- see field-visibility.ts) are kept
 * hidden by the gate answers below ("no"/"yale_college"), per the default
 * template's visibleWhen conditions in templates/field-groups.ts.
 *
 * The caller's `department` must avoid a department-supplement section (see
 * FillDefaultApplicationOptions.department) -- this helper does not know that
 * section's ad hoc fields (they vary per department, e.g.
 * templates/application/supplements/director.ts).
 */
export async function fillDefaultApplication(applyPage: Page, opts: FillDefaultApplicationOptions): Promise<void> {
  const {
    email, department,
    firstName = "Ann", lastName = "Applicant", netId = "e2enetid",
    phone = "203-555-0100", yaleAffiliation = "yale_college", gradYear = "2026",
    maxSteps = 15,
  } = opts;

  await ensureSubcommittee();

  const submit = applyPage.getByRole("button", { name: "Submit application" });
  const continueButton = applyPage.getByRole("button", { name: "Continue" });

  for (let i = 0; i < maxSteps; i++) {
    if (await submit.isVisible().catch(() => false)) break;

    // --- Personal details (identitySection; both tracks) ---
    const firstNameInput = applyPage.locator('input[name="first_name"]');
    if (await firstNameInput.isVisible().catch(() => false)) {
      await firstNameInput.fill(firstName);
      await applyPage.locator('input[name="last_name"]').fill(lastName);
      await applyPage.locator('input[name="net_id"]').fill(netId);
      await applyPage.locator('input[name="email"]').fill(email);
      const phoneInput = applyPage.locator('input[name="phone"]');
      if (await phoneInput.isVisible().catch(() => false)) await phoneInput.fill(phone);
      await applyPage.locator('select[name="yale_affiliation"]').selectOption(yaleAffiliation);
      await applyPage.locator('select[name="grad_year"]').selectOption(gradYear);
    }

    // --- Medical and language experience (eligibilitySection; volunteer only):
    // "No" keeps medical_certifications/medical_details hidden. ---
    const licensedProfessional = applyPage.locator('select[name="licensed_professional"]');
    if (await licensedProfessional.isVisible().catch(() => false)) {
      await licensedProfessional.selectOption("no");
    }

    // --- Languages (languagesSection; both tracks): "None" makes the Spanish
    // assessment path irrelevant; "No" keeps other_languages_detail hidden. ---
    const spanishProficiency = applyPage.locator('select[name="spanish_proficiency"]');
    if (await spanishProficiency.isVisible().catch(() => false)) {
      await spanishProficiency.selectOption("none");
      await applyPage.locator('select[name="other_languages"]').selectOption("no");
    }

    // --- HAVEN experience (directorHavenExperienceSection; director only) ---
    const prevVolunteered = applyPage.locator('select[name="prev_volunteered"]');
    if (await prevVolunteered.isVisible().catch(() => false)) {
      await prevVolunteered.selectOption("no");
      await applyPage.locator('select[name="returning_board"]').selectOption("no");
    }

    // --- Short answer questions (directorEssaysSection; director only) ---
    for (const key of ["essay_community_care", "essay_priorities", "essay_accountability"]) {
      const essay = applyPage.locator(`textarea[name="${key}"]`);
      if (await essay.isVisible().catch(() => false)) await essay.fill("E2E test answer.");
    }

    // --- Department preference (volunteerDepartmentSection / directorDepartmentSection;
    // both use the shared "department_choice" key) ---
    const departmentChoice = applyPage.locator('select[name="department_choice"]');
    if (await departmentChoice.isVisible().catch(() => false)) {
      await departmentChoice.selectOption(department);
    }

    // --- Availability (availabilitySection; both tracks): checking one date
    // satisfies isValuePresent (wizard-validation.ts); no HTML `required`
    // attribute is rendered for MULTI_SELECT checkboxes, so this cannot be
    // detected generically and must be filled explicitly. ---
    const availability = applyPage.locator('input[name="availability"]').first();
    if (await availability.isVisible().catch(() => false) && !(await availability.isChecked())) {
      await availability.check();
    }

    // --- Subcommittee preference (subcommitteeSection; director only): only
    // the first rank is required (submissions.ts resolveRanking). ---
    const subcommitteeRank = applyPage.locator('select[name="subcommittee_rank"]').first();
    if (await subcommitteeRank.isVisible().catch(() => false)) {
      await selectFirstRealOption(subcommitteeRank);
    }

    // --- Cover letter (volunteerDepartmentSection; volunteer only) / resume
    // (both tracks; volunteerDepartmentSection and directorLogisticsSection
    // both key it "resume") ---
    await attachDummyFile(applyPage, "cover_letter");
    await attachDummyFile(applyPage, "resume");

    // --- Volunteer contract acknowledgements (acknowledgementsSection;
    // volunteer only): required SHORT_TEXT "type your initials" fields. ---
    for (const key of ["volunteer_agreement", "professionalism_policy", "training_acknowledgement"]) {
      const field = applyPage.locator(`input[name="${key}"]`);
      if (await field.isVisible().catch(() => false)) await field.fill("AA");
    }

    // --- Logistics (directorLogisticsSection; director only) ---
    const timeCommitments = applyPage.locator('textarea[name="time_commitments"]');
    if (await timeCommitments.isVisible().catch(() => false)) await timeCommitments.fill("None anticipated.");
    const infoSessionConfirm = applyPage.locator('input[name="info_session_confirm"][type="checkbox"]');
    if (await infoSessionConfirm.isVisible().catch(() => false) && !(await infoSessionConfirm.isChecked())) {
      await infoSessionConfirm.check();
    }

    await continueButton.click();
  }

  await expect(submit).toBeVisible();
  await submit.click();
  await expect(applyPage.getByText(/your application was received/i)).toBeVisible();
}
