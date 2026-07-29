/**
 * Dev-only UX audit fixture builder.
 *
 * Builds the personas and app states the 2026-07-28 whole-app UX audit needs to
 * walk its ten user journeys. The base `prisma/seed.ts` only creates three
 * people and a term, so nothing past the dashboard is walkable without this.
 *
 * This is NOT part of `prisma db seed` and is deliberately kept out of it: it
 * writes audit-specific fixtures (an open recruitment cycle, a half-finished
 * application draft, an accepted applicant mid-onboarding, a SCORM course, shift
 * assignments, an incident report, a tech request, notifications) that no other
 * workflow wants. Delete this file once the audit ships.
 *
 * Run with:
 *   npm run fixtures:ux
 *
 * Idempotent for the HIPAA certificate and the application draft: those two steps
 * detect a consumed fixture and rebuild it, so it is safe to re-run after a journey
 * task has poked at that data. The accepted applicant's onboarding contract does NOT
 * self-heal: a re-run reuses any existing contract regardless of status, so a journey
 * task that has advanced it past PENDING leaves it that way until the row is deleted
 * or reset by hand.
 *
 * Prerequisites: `npm run db:seed` has already run against the same database.
 */
import { zipSync, strToU8 } from "fflate";
import { prisma } from "@/platform/db";
import { putObject, deleteObject, usingBlobStorage } from "@/platform/storage";
import { isoDateKey } from "@/platform/dates";
import { createNotification } from "@/platform/notifications/inbox";
import { createCycle, publishCycle } from "@/modules/recruitment/services/cycles";
import { saveDraft } from "@/modules/recruitment/services/drafts";
import { submitApplication } from "@/modules/recruitment/services/submissions";
import { routeApplication, decideRoutedApplication } from "@/modules/recruitment/services/routing";
import { listAcceptances } from "@/modules/recruitment/services/review";
import { createOrResendContract } from "@/modules/recruitment/services/onboarding";
import { setTrainingCycle, updateQuizSettings, completeTraining } from "@/modules/recruitment/services/training";
import { createCourse, setCourseAssignment } from "@/modules/learning/services/courses";
import { ingestScormPackage } from "@/modules/learning/services/packages";
import { persistScoCmi } from "@/modules/learning/services/enrollment";
import { setAssignment, toggleTag } from "@/modules/schedule/services/builder";
import { submitReport } from "@/modules/incidents/services/report";
import { createTechRequest } from "@/modules/support/services/tech-request";

// ---------------------------------------------------------------------------
// Fixture identifiers. Tasks 4 through 8 of the audit reference these verbatim.
// Renaming any of them breaks a downstream journey walk.
// ---------------------------------------------------------------------------

const FRESH_EMAIL = "ux.fresh@yale.edu";
const PENDING_EMAIL = "ux.pending@yale.edu";
const APPLICANT_EMAIL = "ux.applicant@yale.edu";
const ACCEPTED_EMAIL = "ux.accepted@yale.edu";
const CYCLE_SLUG = "ux-audit-cycle";
const COURSE_TITLE = "UX Audit Course";

/** Where the onboarding link in the fixture contract email points. */
const BASE_URL = "http://localhost:3000";

/** Marker text used to recognise fixtures this script already created. */
const FIXTURE_MARK = "[UX audit fixture]";

// ---------------------------------------------------------------------------
// Reporting helpers
// ---------------------------------------------------------------------------

let created = 0;
let skipped = 0;

function report(action: "created" | "skipped", what: string, detail = ""): void {
  if (action === "created") created += 1;
  else skipped += 1;
  console.log(`  [${action}] ${what}${detail ? ` ${detail}` : ""}`);
}

function heading(text: string): void {
  console.log(`\n${text}`);
}

/** The throwaway database this audit runs against. Not configurable on purpose:
 *  an env override would reintroduce exactly the accident the check below exists
 *  to prevent (a stale export in a shell). If the audit moves to a differently
 *  named database, change this constant. */
const AUDIT_DATABASE = "havenhub_uxaudit";

/**
 * Refuse to run against anything but the throwaway audit database.
 *
 * The host check alone is not enough. `.env.example` ships
 * `postgresql://haven:haven_dev@localhost:5434/havenhub`: the same host AND the
 * same port as the audit database, differing only in the database name. A
 * developer with a conventional local `.env` would otherwise pass a "looks
 * local" check and get ~25 fixture rows written into their real working dev
 * database. So assert the database name too, and print every component that was
 * actually checked rather than implying more than was.
 */
function assertAuditDatabase(): void {
  const raw = process.env.DATABASE_URL ?? "";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      "DATABASE_URL is missing or unparseable. It should be loaded from .env.local " +
        `and point at ${AUDIT_DATABASE} on localhost.`,
    );
  }
  const host = url.hostname;
  const port = url.port || "5432";
  const database = url.pathname.replace(/^\//, "");

  if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
    throw new Error(
      `Refusing to build audit fixtures against a non-local database (host: ${host || "unknown"}). ` +
        `Expected localhost. Check that DATABASE_URL is loaded from .env.local.`,
    );
  }
  if (database !== AUDIT_DATABASE) {
    throw new Error(
      `Refusing to build audit fixtures against database "${database || "(none)"}" on ${host}:${port}. ` +
        `This script writes about 25 fixture rows and expects the throwaway audit database ` +
        `"${AUDIT_DATABASE}". A conventional local .env points at "havenhub", the real working dev ` +
        `database, on the same host and port. Check that DATABASE_URL is loaded from .env.local.`,
    );
  }
  console.log(`Database: ${database} on ${host}:${port}`);
}

/**
 * Refuse to run with real Blob storage configured.
 *
 * `assertAuditDatabase` only guards the database. `usingBlobStorage` picks Vercel
 * Blob over local disk based on `BLOB_READ_WRITE_TOKEN` alone, with no per-database
 * scoping, so a developer with a real token would pass the database guard and then
 * write fixture PDFs, and on the rebuild path run `deleteObject` against them, in
 * the shared Blob store rather than a throwaway one.
 */
function assertLocalStorage(): void {
  if (usingBlobStorage) {
    throw new Error(
      "Refusing to build audit fixtures with BLOB_READ_WRITE_TOKEN set. This script " +
        "writes fixture PDFs, and deletes them again on rebuild, under keys that would " +
        "land in the real Blob store instead of a throwaway one. Unset " +
        "BLOB_READ_WRITE_TOKEN so storage falls back to local disk.",
    );
  }
}

// ---------------------------------------------------------------------------
// A minimal, genuinely valid SCORM 1.2 package
// ---------------------------------------------------------------------------

/**
 * One SCO page. The stylesheet and script are separate files inside the package
 * on purpose: the content route serves every package file under
 * `default-src 'self'`, which blocks inline <style> and <script>, so an
 * all-in-one page renders but its buttons silently do nothing.
 */
function scoPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="sco.css">
</head>
<body>
<h1>${title}</h1>
${body}
<p class="state" id="state">Status: loading</p>
<p>
  <button id="complete">Mark this module complete</button>
  <button id="reset" class="secondary">Mark it incomplete again</button>
</p>
<script src="sco.js"></script>
</body>
</html>
`;
}

const SCO_CSS = `body { font: 16px/1.5 system-ui, sans-serif; margin: 0; padding: 2rem; color: #1c2024; }
h1 { font-size: 1.35rem; margin: 0 0 0.75rem; }
p { max-width: 42rem; }
.state { font-weight: 600; margin: 1.25rem 0; }
button { font: inherit; padding: 0.55rem 1rem; border-radius: 0.5rem; border: 1px solid #1c2024; background: #1c2024; color: #fff; cursor: pointer; }
button.secondary { background: #fff; color: #1c2024; }
`;

const SCO_JS = `(function () {
  function findApi(win, depth) {
    if (depth > 10 || !win) return null;
    if (win.API) return win.API;
    if (win.parent && win.parent !== win) return findApi(win.parent, depth + 1);
    return null;
  }
  var api = findApi(window, 0);
  var state = document.getElementById("state");
  function show() {
    state.textContent = api
      ? "Status: " + (api.LMSGetValue("cmi.core.lesson_status") || "not attempted")
      : "Status: no SCORM runtime found (open this from the course player)";
  }
  function set(value) {
    if (!api) return;
    api.LMSSetValue("cmi.core.lesson_status", value);
    api.LMSCommit("");
    show();
  }
  if (api) api.LMSInitialize("");
  show();
  document.getElementById("complete").addEventListener("click", function () { set("completed"); });
  document.getElementById("reset").addEventListener("click", function () { set("incomplete"); });
  window.addEventListener("unload", function () { if (api) api.LMSFinish(""); });
})();
`;

const MANIFEST_XML = `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="ux-audit-course" version="1.0"
  xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2">
  <metadata>
    <schema>ADL SCORM</schema>
    <schemaversion>1.2</schemaversion>
  </metadata>
  <organizations default="org-1">
    <organization identifier="org-1">
      <title>UX Audit Course</title>
      <item identifier="item-1" identifierref="res-1">
        <title>Module 1: Clinic overview</title>
      </item>
      <item identifier="item-2" identifierref="res-2">
        <title>Module 2: Knowledge check</title>
      </item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="res-1" type="webcontent" adlcp:scormtype="sco" href="module-1.html">
      <file href="module-1.html"/>
      <file href="sco.css"/>
      <file href="sco.js"/>
    </resource>
    <resource identifier="res-2" type="webcontent" adlcp:scormtype="sco" href="module-2.html">
      <file href="module-2.html"/>
      <file href="sco.css"/>
      <file href="sco.js"/>
    </resource>
  </resources>
</manifest>
`;

function buildScormZip(): Buffer {
  const files = {
    "imsmanifest.xml": strToU8(MANIFEST_XML),
    "sco.css": strToU8(SCO_CSS),
    "sco.js": strToU8(SCO_JS),
    "module-1.html": strToU8(
      scoPage(
        "Module 1: Clinic overview",
        "<p>A placeholder module used only by the UX audit fixtures. It exists so the SCORM player, the table of contents, and the completion rollup all have real content to render.</p>",
      ),
    ),
    "module-2.html": strToU8(
      scoPage(
        "Module 2: Knowledge check",
        "<p>The second module in the fixture package. Two modules mean the player renders its table of contents and the course only rolls up to complete once both are finished.</p>",
      ),
    ),
  };
  return Buffer.from(zipSync(files, { level: 6 }));
}

/** A byte-valid single-page PDF, so uploaded-file fixtures are actually openable. */
function tinyPdf(label: string): Buffer {
  const text = label.replace(/[()\\]/g, "");
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    `5 0 obj\n<< /Length ${44 + text.length} >>\nstream\nBT /F1 18 Tf 72 700 Td (${text}) Tj ET\nendstream\nendobj\n`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(pdf.length);
    pdf += obj;
  }
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

// ---------------------------------------------------------------------------
// Quiz answer key
// ---------------------------------------------------------------------------

/**
 * The default quiz template ships with NO answer key on purpose (directors set
 * `correctValue` per cycle after publishing). Without one, `gradeQuiz` scores
 * every attempt 0/0 and nobody can ever pass, so the training journey dead-ends.
 * These are the substantively correct choices, stored as the zero-based index of
 * the option in each question's own option list so the mapping survives any
 * change to how option values are slugified.
 */
const QUIZ_ANSWER_INDEX: Record<string, number> = {
  quiz_population: 2,
  quiz_mission: 0,
  quiz_volunteers_importance: 0,
  quiz_language_record: 3,
  quiz_epic_phrase: 2,
  quiz_sensitive_info: 1,
  quiz_hipaa_protects: 1,
  quiz_patient_identifier: 3,
  quiz_also_ask: 3,
  quiz_avoid_action: 0,
  quiz_clinic_location: 1,
  quiz_contact_scheduling: 0,
  quiz_contact_it: 2,
  quiz_ipv_disclosure: 1,
  quiz_access_check_timing: 1,
};

// ---------------------------------------------------------------------------
// Person helpers
// ---------------------------------------------------------------------------

type PersonSeed = { email: string; name: string; netId: string; phone: string | null };

async function ensurePerson(seed: PersonSeed): Promise<string> {
  const existing = await prisma.person.findUnique({ where: { contactEmail: seed.email } });
  if (existing) {
    report("skipped", `person ${seed.email}`);
    return existing.id;
  }
  const person = await prisma.person.create({
    data: { name: seed.name, contactEmail: seed.email, netId: seed.netId, phone: seed.phone },
  });
  report("created", `person ${seed.email}`, `(${seed.phone ? "has phone" : "no phone"})`);
  return person.id;
}

async function ensureMembership(
  personId: string,
  termId: string,
  departmentId: string,
  kind: "DIRECTOR" | "VOLUNTEER",
): Promise<void> {
  await prisma.termMembership.upsert({
    where: { personId_termId_departmentId_kind: { personId, termId, departmentId, kind } },
    update: { status: "ACTIVE" },
    create: { personId, termId, departmentId, kind },
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  assertAuditDatabase();
  assertLocalStorage();

  // --- base entities from prisma/seed.ts -----------------------------------
  const term = await prisma.term.findFirst({ where: { status: "ACTIVE" }, orderBy: { startDate: "desc" } });
  if (!term) throw new Error("No ACTIVE term. Run `npm run db:seed` first.");
  const vadm = await prisma.department.findUniqueOrThrow({ where: { code: "VADM" } });
  const admin = await prisma.person.findUniqueOrThrow({ where: { contactEmail: "j.carney@yale.edu" } });
  const devVolunteer = await prisma.person.findUniqueOrThrow({ where: { contactEmail: "dev.volunteer@yale.edu" } });
  const devDirector = await prisma.person.findUniqueOrThrow({ where: { contactEmail: "dev.director@yale.edu" } });
  const clinicDates = [...term.clinicDates].sort((a, b) => a.getTime() - b.getTime());
  const dateKeys = clinicDates.map((d) => isoDateKey(d));
  console.log(`Term ${term.code} with ${clinicDates.length} clinic dates.`);

  // --- 1. ux.fresh: no cert, no phone, so the onboarding gate fires --------
  heading("1. Fresh volunteer (Journey 3 gate, Journey 4 upload walk)");
  const freshId = await ensurePerson({
    email: FRESH_EMAIL,
    name: "Uxa Fresh",
    netId: "uxf001",
    phone: null,
  });
  await ensureMembership(freshId, term.id, vadm.id, "VOLUNTEER");

  // --- 2. ux.pending: cert on file, awaiting a manager's verification ------
  heading("2. Volunteer awaiting certificate verification (Journey 4)");
  const pendingId = await ensurePerson({
    email: PENDING_EMAIL,
    name: "Uxa Pending",
    netId: "uxp002",
    phone: "203-555-0177",
  });
  await ensureMembership(pendingId, term.id, vadm.id, "VOLUNTEER");
  // Guard on the STATE the journey needs, not on the row existing. Journey 4
  // ends with a manager verifying this certificate, and PENDING_VERIFICATION is
  // unrecoverable once verifiedAt is stamped (complianceStatus checks verifiedAt
  // before any expiry math). Keying on "a certificate exists" would report the
  // fixture present when the state behind it is gone.
  const pendingCert = await prisma.hipaaCertificate.findFirst({ where: { personId: pendingId, verifiedAt: null } });
  if (pendingCert) {
    report("skipped", `unverified HIPAA certificate for ${PENDING_EMAIL}`, "(still PENDING_VERIFICATION)");
  } else {
    // Drop any verified certificate first, so the rebuild restores the fixture
    // exactly (one certificate, unverified) instead of leaving a valid verified
    // one behind that would keep this persona cleared and past the gate.
    const consumed = await prisma.hipaaCertificate.findMany({ where: { personId: pendingId } });
    for (const old of consumed) {
      await prisma.hipaaCertificate.delete({ where: { id: old.id } });
      await deleteObject(old.storedName).catch(() => {});
    }
    const cert = await prisma.hipaaCertificate.create({
      data: {
        personId: pendingId,
        fileName: "hipaa-certificate.pdf",
        storedName: "pending",
        size: 0,
        mimeType: "application/pdf",
        // A completion date with no verifiedAt is exactly PENDING_VERIFICATION.
        completionDate: new Date(Date.now() - 30 * 86_400_000),
        extraction: "PARSED",
      },
    });
    const bytes = tinyPdf("HAVEN Hub UX audit fixture HIPAA certificate");
    await prisma.hipaaCertificate.update({ where: { id: cert.id }, data: { storedName: `${cert.id}.pdf`, size: bytes.length } });
    await putObject(`${cert.id}.pdf`, bytes, "application/pdf");
    const detail = consumed.length > 0 ? "(rebuilt, the previous one had been verified)" : "(PENDING_VERIFICATION)";
    report("created", `unverified HIPAA certificate for ${PENDING_EMAIL}`, detail);
  }

  // --- 3. the open recruitment cycle, which doubles as this term's training -
  heading("3. Open recruitment cycle + designated training cycle (Journeys 1, 5)");
  let cycle = await prisma.recruitmentCycle.findUnique({ where: { publicSlug: CYCLE_SLUG } });
  if (cycle) {
    report("skipped", `cycle ${CYCLE_SLUG}`, `(${cycle.status})`);
  } else {
    cycle = await createCycle(
      {
        track: "VOLUNTEER",
        termId: term.id,
        title: `${term.name} volunteer application`,
        publicSlug: CYCLE_SLUG,
        // VADM first: the accepted-applicant fixture routes there, and VADM
        // requires Epic for every volunteer, so onboarding provisioning is
        // actually observable. MDIC and PATS carry supplement sections, which
        // give the form real conditional depth to audit.
        departments: ["VADM", "MDIC", "PATS"],
        acceptsRenewals: true,
        createdById: admin.id,
      },
      true,
    );
    cycle = await publishCycle(cycle.id, admin.id);
    report("created", `cycle ${CYCLE_SLUG}`, "(default template, OPEN)");
  }
  const cycleId = cycle.id;

  if (cycle.isTermTraining) {
    report("skipped", "training-cycle designation");
  } else {
    await setTrainingCycle(cycleId, true, admin.id);
    report("created", "training-cycle designation", `(${term.code}, VOLUNTEER)`);
  }

  // A past in-person date is what opens the makeup quiz (makeupIsOpen). Anchored
  // on the term's start date rather than "14 days ago" so re-running the script
  // on a later day is a genuine no-op instead of a rewrite.
  const trainingDate = new Date(`${isoDateKey(term.startDate)}T12:00:00Z`);
  const trainingLocation = "Yale Physicians Building, 800 Howard Avenue, Room 1A";
  if (cycle.inPersonTrainingDate?.getTime() === trainingDate.getTime() && cycle.trainingLocation === trainingLocation) {
    report("skipped", "quiz settings");
  } else {
    await updateQuizSettings(
      cycleId,
      { quizPassPercent: 80, quizMaxAttempts: 3, inPersonTrainingDate: trainingDate, trainingLocation },
      admin.id,
    );
    report("created", "quiz settings", "(80% to pass, 3 attempts, makeup window open)");
  }

  const quizFields = await prisma.formField.findMany({
    where: { cycleId, type: "SINGLE_SELECT", section: { purpose: "QUIZ" } },
    select: { id: true, key: true, options: true, correctValue: true },
  });
  let answersSet = 0;
  for (const field of quizFields) {
    const index = QUIZ_ANSWER_INDEX[field.key];
    if (index === undefined) continue;
    const options = (field.options as { value: string; label: string }[] | null) ?? [];
    const correctValue = options[index]?.value;
    if (!correctValue || field.correctValue === correctValue) continue;
    await prisma.formField.update({ where: { id: field.id }, data: { correctValue } });
    answersSet += 1;
  }
  if (answersSet > 0) report("created", "quiz answer key", `(${answersSet} of ${quizFields.length} questions)`);
  else report("skipped", "quiz answer key", `(${quizFields.length} questions already keyed)`);

  // --- 4. ux.applicant: a half-finished draft to resume --------------------
  heading("4. Half-finished application draft (Journey 1)");
  // Guard on a live DRAFT, not on the Applicant row. Application.status is only
  // DRAFT | SUBMITTED and submitApplication flips the same row in place, so once
  // a journey walks the resume-draft path to completion the DRAFT is gone for
  // good and an applicant-row check would report a fixture that is not there.
  const draftApplicant = await prisma.applicant.findUnique({
    where: { cycleId_emailLower: { cycleId, emailLower: APPLICANT_EMAIL } },
    include: { applications: true },
  });
  if (draftApplicant?.applications.some((a) => a.status === "DRAFT")) {
    report("skipped", `draft for ${APPLICANT_EMAIL}`, "(still DRAFT)");
  } else {
    // Drop the consumed applicant so saveDraft takes its create path (it refuses
    // to write over a SUBMITTED row). Applications cascade with the applicant.
    // Nothing else references this persona, whose submitted application is a
    // by-product of the walk rather than a fixture any journey needs.
    const rebuild = draftApplicant != null;
    if (draftApplicant) await prisma.applicant.delete({ where: { id: draftApplicant.id } });
    // Answers stop partway through the wizard on purpose: identity and the
    // language step are filled, everything from the department step onward is
    // blank, so "resume where I left off" has something real to resume.
    await saveDraft(
      CYCLE_SLUG,
      { email: APPLICANT_EMAIL, personId: null, firstName: "Uxa" },
      {
        applicantType: "NEW",
        answers: {
          first_name: "Uxa",
          last_name: "Applicant",
          net_id: "uxa003",
          email: APPLICANT_EMAIL,
          phone: "203-555-0166",
          yale_affiliation: "yale_college",
          grad_year: "2029",
          licensed_professional: "no",
          spanish_proficiency: "some",
          other_languages: "no",
        },
      },
    );
    report(
      "created",
      `draft for ${APPLICANT_EMAIL}`,
      rebuild ? "(rebuilt, the previous draft had been submitted)" : "(stops before the department step)",
    );
  }

  // --- 5. ux.accepted: submitted, routed, accepted, contract sent ----------
  heading("5. Accepted applicant with a pending onboarding contract (Journey 2)");
  const acceptedApplicant = await prisma.applicant.findUnique({
    where: { cycleId_emailLower: { cycleId, emailLower: ACCEPTED_EMAIL } },
    include: { applications: true },
  });
  let acceptedApplicationId = acceptedApplicant?.applications.find((a) => a.status === "SUBMITTED")?.id ?? null;
  if (acceptedApplicationId) {
    report("skipped", `submitted application for ${ACCEPTED_EMAIL}`);
  } else {
    const application = await submitApplication(CYCLE_SLUG, {
      applicantType: "NEW",
      identityEmail: ACCEPTED_EMAIL,
      answers: {
        first_name: "Uxa",
        last_name: "Accepted",
        net_id: "uxa004",
        email: ACCEPTED_EMAIL,
        phone: "203-555-0155",
        yale_affiliation: "ysn",
        grad_year: "2028",
        licensed_professional: "no",
        spanish_proficiency: "conversational",
        other_languages: "no",
        department_choice: "VADM",
        department_flexibility: "yes",
        switch_departments: "yes",
        availability: dateKeys.slice(0, 6),
        volunteer_agreement: "Uxa Accepted",
        professionalism_policy: "Uxa Accepted",
        training_acknowledgement: "Uxa Accepted",
        additional_info: `${FIXTURE_MARK} submitted by the UX audit fixture builder.`,
      },
      files: {
        cover_letter: { fileName: "cover-letter.pdf", mimeType: "application/pdf", bytes: tinyPdf("UX audit fixture cover letter") },
        resume: { fileName: "resume.pdf", mimeType: "application/pdf", bytes: tinyPdf("UX audit fixture resume") },
      },
    });
    acceptedApplicationId = application.id;
    report("created", `submitted application for ${ACCEPTED_EMAIL}`, "(VADM)");
  }

  const routed = await prisma.application.findUniqueOrThrow({ where: { id: acceptedApplicationId } });
  if (routed.routedDepartmentCode === "VADM") {
    report("skipped", "routing to VADM");
  } else {
    await routeApplication(acceptedApplicationId, "VADM", admin.id);
    report("created", "routing to VADM");
  }
  if (routed.decision === "ACCEPT") {
    report("skipped", "accept decision");
  } else {
    await decideRoutedApplication(acceptedApplicationId, "ACCEPT", admin.id, `${FIXTURE_MARK} accepted for the audit walk.`);
    report("created", "accept decision");
  }

  const acceptances = await listAcceptances(acceptedApplicationId);
  const acceptance = acceptances[0];
  if (!acceptance) throw new Error("Expected an Acceptance after the ACCEPT decision.");
  const existingContract = await prisma.onboardingContract.findUnique({ where: { acceptanceId: acceptance.id } });
  const contract = existingContract ?? (await createOrResendContract(acceptance.id, admin.id, BASE_URL));
  report(existingContract ? "skipped" : "created", `onboarding contract for ${ACCEPTED_EMAIL}`, `(${contract.status})`);
  console.log(`         onboarding link: ${BASE_URL}/onboard/${contract.token}`);

  // --- 6. the learning course, with a real SCORM package ------------------
  heading("6. Assigned course with an ingested SCORM package (Journey 5)");
  let course = await prisma.course.findFirst({ where: { title: COURSE_TITLE } });
  if (course) {
    report("skipped", `course "${COURSE_TITLE}"`);
  } else {
    course = await createCourse(
      {
        title: COURSE_TITLE,
        description: "A two-module placeholder course created for the UX audit so the learning journey has real content.",
      },
      admin.id,
    );
    report("created", `course "${COURSE_TITLE}"`);
  }
  // Audience VOLUNTEERS keeps the course off dev.director's onboarding checklist,
  // so the director stays cleared and can be used for the empty-state walks.
  const assignedToVadm = await prisma.courseDepartment.findFirst({ where: { courseId: course.id, departmentId: vadm.id } });
  if (assignedToVadm && course.audience === "VOLUNTEERS" && !course.assignToAll) {
    report("skipped", "course assignment to VADM");
  } else {
    await setCourseAssignment(course.id, { departmentIds: [vadm.id], assignToAll: false, audience: "VOLUNTEERS" }, admin.id);
    report("created", "course assignment to VADM", "(volunteers only)");
  }

  if (course.scormEntryHref) {
    report("skipped", "SCORM package ingest", `(entry ${course.scormEntryHref})`);
  } else {
    // coursesForMember hard-excludes a package-less course, so without this the
    // course is invisible on /learning rather than merely unplayable.
    await ingestScormPackage(course.id, buildScormZip(), admin.id);
    const ingested = await prisma.course.findUniqueOrThrow({ where: { id: course.id } });
    const scoCount = (ingested.scormScos as unknown as { id: string }[]).length;
    report("created", "SCORM package ingest", `(entry ${ingested.scormEntryHref}, ${scoCount} SCOs)`);
  }

  // --- 7. keep dev.volunteer past the onboarding gate ----------------------
  //
  // Designating a training cycle and assigning a course both add BLOCKING
  // onboarding tasks to every active VADM volunteer, dev.volunteer included.
  // Left incomplete, the gate redirects them to /get-started on every (app)
  // path, which would take /schedule, /incidents, /support, /notifications,
  // /learning, and /training out of reach and kill four journeys outright.
  // Completing both for dev.volunteer is the state of an ordinary cleared
  // returning volunteer. The uncleared side of these two steps is walkable as
  // ux.fresh, who reaches the same quiz and player under /get-started.
  heading("7. Clear dev.volunteer for the term (keeps Journeys 5 to 10 reachable)");
  const trainingRow = await prisma.training.findUnique({
    where: { personId_termId_track: { personId: devVolunteer.id, termId: term.id, track: "VOLUNTEER" } },
  });
  if (trainingRow?.status === "COMPLETE") {
    report("skipped", "dev.volunteer training completion");
  } else {
    await completeTraining(prisma, {
      personId: devVolunteer.id,
      termId: term.id,
      cycleId,
      track: "VOLUNTEER",
      via: "ATTENDANCE",
      actorId: admin.id,
    });
    report("created", "dev.volunteer training completion", "(via live session)");
  }

  const courseRollup = await prisma.courseProgress.findUnique({
    where: { personId_courseId: { personId: devVolunteer.id, courseId: course.id } },
  });
  if (courseRollup?.status === "COMPLETE") {
    report("skipped", "dev.volunteer course completion");
  } else {
    const fresh = await prisma.course.findUniqueOrThrow({ where: { id: course.id } });
    const scos = (fresh.scormScos as unknown as { id: string }[]) ?? [];
    for (const sco of scos) {
      await persistScoCmi(devVolunteer.id, course.id, sco.id, {
        lessonStatus: "completed",
        scoreRaw: null,
        suspendData: null,
        lessonLocation: null,
      });
    }
    report("created", "dev.volunteer course completion", `(${scos.length} SCOs)`);
  }

  // --- 8. shift assignments ------------------------------------------------
  heading("8. Shift assignments across the term (Journey 6)");
  // Every clinic date carries the department's director plus at least one
  // volunteer, so /schedule/full has a real table to scan on whichever date it
  // lands on (it opens on the next upcoming clinic date, not the first one).
  const everyDate = clinicDates.map((_, i) => i);
  const roster: { personId: string; label: string; role: "VOLUNTEER" | "DIRECTOR"; indexes: number[] }[] = [
    { personId: devDirector.id, label: "dev.director", role: "DIRECTOR", indexes: everyDate },
    { personId: devVolunteer.id, label: "dev.volunteer", role: "VOLUNTEER", indexes: everyDate.filter((i) => i % 2 === 1) },
    { personId: pendingId, label: PENDING_EMAIL, role: "VOLUNTEER", indexes: everyDate.filter((i) => i < 10) },
    { personId: freshId, label: FRESH_EMAIL, role: "VOLUNTEER", indexes: [9, 11, 13] },
  ];
  for (const entry of roster) {
    let made = 0;
    for (const index of entry.indexes) {
      const clinicDate = clinicDates[index];
      if (!clinicDate) continue;
      const existing = await prisma.shiftAssignment.findFirst({
        where: { termId: term.id, departmentId: vadm.id, clinicDate, personId: entry.personId },
      });
      if (existing) continue;
      await setAssignment(admin.id, {
        termId: term.id,
        departmentId: vadm.id,
        dateKey: dateKeys[index],
        personId: entry.personId,
        role: entry.role,
      });
      made += 1;
    }
    if (made > 0) report("created", `shifts for ${entry.label}`, `(${made} of ${entry.indexes.length} dates)`);
    else report("skipped", `shifts for ${entry.label}`, `(${entry.indexes.length} dates already assigned)`);
  }

  // A couple of role tags so the schedule cards are not all identical.
  const tagPlan: { index: number; tag: "triage" | "walkin" }[] = [
    { index: 1, tag: "triage" },
    { index: 9, tag: "walkin" },
  ];
  let tagged = 0;
  for (const plan of tagPlan) {
    const clinicDate = clinicDates[plan.index];
    if (!clinicDate) continue;
    const row = await prisma.shiftAssignment.findFirst({
      where: { termId: term.id, departmentId: vadm.id, clinicDate, personId: devVolunteer.id },
    });
    if (!row || row[plan.tag]) continue;
    await toggleTag(admin.id, {
      termId: term.id,
      departmentId: vadm.id,
      dateKey: dateKeys[plan.index],
      personId: devVolunteer.id,
      tag: plan.tag,
    });
    tagged += 1;
  }
  if (tagged > 0) report("created", "shift tags for dev.volunteer", `(${tagged})`);
  else report("skipped", "shift tags for dev.volunteer");

  // --- 9. an incident report filed by dev.volunteer ------------------------
  heading("9. Existing incident report (Journey 7)");
  const existingReport = await prisma.incidentReport.findFirst({
    where: { reporterId: devVolunteer.id, description: { contains: FIXTURE_MARK } },
  });
  if (existingReport) {
    report("skipped", "incident report by dev.volunteer", `(#${existingReport.number})`);
  } else {
    const incident = await submitReport(devVolunteer.id, {
      concernTypes: ["DOCUMENTATION_WORKFLOW", "ATTENDANCE_RELIABILITY"],
      description:
        `${FIXTURE_MARK} A referral placed at the end of clinic was left unsigned and the covering volunteer ` +
        `had already left, so the hand-off note was never completed. Flagging it so the workflow gap is on record.`,
      occurredAt: clinicDates[0] ?? new Date(Date.now() - 7 * 86_400_000),
      setting: "Saturday clinic, front desk",
      issueNature: "SYSTEM",
      priorOccurrence: "UNSURE",
      immediateRisk: false,
      anonymous: false,
    });
    report("created", "incident report by dev.volunteer", `(#${incident.number})`);
  }

  // --- 10. a tech request filed by dev.volunteer ---------------------------
  heading("10. Existing tech request (Journey 8)");
  const existingRequest = await prisma.techRequest.findFirst({
    where: { requesterId: devVolunteer.id, description: { contains: FIXTURE_MARK } },
  });
  if (existingRequest) {
    report("skipped", "tech request by dev.volunteer", `(#${existingRequest.number})`);
  } else {
    const request = await createTechRequest(devVolunteer.id, {
      category: "TEAMS",
      subject: "Cannot open the HAVEN Teams channel on my laptop",
      description:
        `${FIXTURE_MARK} Teams says I do not have access to the clinic channel when I sign in on my laptop, ` +
        `though it works on my phone. It started after the last shift.`,
    });
    report("created", "tech request by dev.volunteer", `(#${request.number})`);
  }

  // --- 11. notifications ---------------------------------------------------
  heading("11. Notifications for dev.volunteer (Journey 10)");
  const notificationSeeds: { type: string; title: string; body: string; link: string; read: boolean }[] = [
    {
      type: "shift-reminder",
      title: "You are on the schedule this Saturday",
      body: "You are scheduled with Vaccine Administration for the next clinic. Check the schedule for your role and tags.",
      link: "/schedule",
      read: false,
    },
    {
      type: "support.ticket_submitted",
      title: "We received your IT request",
      body: "Your request about Teams access has been logged. You will get an update when someone picks it up.",
      link: "/support",
      read: false,
    },
    {
      type: "compliance-reminder",
      title: "Your HIPAA certificate is on file",
      body: "Thanks, your certificate has been verified and is valid through the end of the term.",
      link: "/my-info",
      read: true,
    },
  ];
  const existingNotifications = await prisma.notification.count({ where: { personId: devVolunteer.id } });
  if (existingNotifications >= notificationSeeds.length) {
    report("skipped", "notifications for dev.volunteer", `(${existingNotifications} already on file)`);
  } else {
    for (const seed of notificationSeeds) {
      const row = await createNotification(prisma, {
        personId: devVolunteer.id,
        type: seed.type,
        title: seed.title,
        body: seed.body,
        link: seed.link,
      });
      if (seed.read) {
        await prisma.notification.update({ where: { id: row.id }, data: { readAt: new Date() } });
      }
    }
    report("created", "notifications for dev.volunteer", "(2 unread, 1 read)");
  }

  // --- summary -------------------------------------------------------------
  heading("Summary");
  console.log(`  ${created} created, ${skipped} skipped.`);
  console.log("");
  console.log("  Walk-in points:");
  console.log(`    apply form         ${BASE_URL}/apply/${CYCLE_SLUG}`);
  console.log(`    resume draft as    ${APPLICANT_EMAIL} (magic link from /apply)`);
  console.log(`    onboarding link    ${BASE_URL}/onboard/${contract.token}`);
  console.log(`    gated persona      ${FRESH_EMAIL} (no cert, no phone)`);
  console.log(`    pending cert       ${PENDING_EMAIL}`);
  console.log(`    cleared volunteer  dev.volunteer@yale.edu`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
