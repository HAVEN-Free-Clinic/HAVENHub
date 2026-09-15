import { prisma } from "@/platform/db";
import { assertLocalTestDatabase } from "@/platform/test/db-target";
import { _resetSettingsCache } from "@/platform/settings/service";
import { _resetSenderRulesCache } from "@/platform/email/sender-rules";

/** Truncate all platform tables between tests. Test database only. */
export async function resetDb() {
  // "Test database only" is now enforced, not just documented. On 2026-09-04 a
  // vitest run started without vitest.setup.ts left DATABASE_URL pointing at
  // .env's production Neon URL, and this function truncated it. See db-target.ts
  // for the full chain. Checked on every call rather than once at import: the
  // env var is what Prisma resolved the connection from, and a test is free to
  // change it.
  assertLocalTestDatabase();

  // CASCADE handles FK ordering. (RESTART IDENTITY would be a no-op: all PKs are cuid text.)
  // The Historical* tables are named explicitly even though CASCADE would reach
  // them through their optional Person FK: that reach is an accident of the
  // relation existing, and it would silently stop working the day a historical
  // identity stops pointing at Person at all.
  const sql =
    `TRUNCATE "EhsTrainingDepartment", "EhsCompletion", "EhsTraining", "CourseProgress", "CourseDepartment", "Course",
              "QuizAttempt", "Training", "Evaluation", "InterviewPanelist", "Interview", "OnboardingContract", "Acceptance", "CommitteeScore", "Application", "Applicant", "Subcommittee", "FormField", "FormSection", "RecruitmentCycleEmail", "RecruitmentCycle",
              "TriageChatMember", "TriageChat", "TriageChatPresetDepartment", "TriageChatPreset",
              "ShiftRequest", "SchedulePublication", "ScheduleDay", "ClinicDayAttending", "ClinicDay", "ClinicSlot", "AttendingCredentialing", "AttendingCapabilityValue", "AttendingCapability", "Attending", "AttendingSpecialty",
              "ClinicAttendance", "ShiftAssignment", "HipaaCertificate", "RoleAssignment", "RoleGrant", "Role", "TermMembership",
              "SpanishAssessmentRecord",
              "DepartmentDelegation", "Department", "TermOnboardingStep", "Term", "Person", "AuditLog",
              "OffboardFlag", "EpicRequest", "YnhhTicket", "TechRequest", "TechRequestComment", "TechRequestAttachment", "DisciplinaryAction", "Notification", "EmailLog", "EmailCampaignRun", "EmailCampaign", "EmailTemplate",
              "ComplianceReminder", "ReminderDispatch", "MailCredential", "Setting", "EmailSenderRule",
              "ApplicantPortalToken", "MemberLoginToken", "CalendarFeedToken",
              "HistoricalInterest", "HistoricalApplication", "HistoricalApplicantEmail", "HistoricalApplicant" CASCADE`;
  await truncate(sql);
  // The settings resolver holds a process-global 30s in-memory cache. We just
  // truncated "Setting", so any cached override is now stale -- clear it so a
  // setSetting in one test file cannot leak into another file's getSetting.
  _resetSettingsCache();
  // The sender-rule resolver holds a process-global cache; we just truncated
  // "EmailSenderRule", so clear it to avoid cross-test leakage.
  _resetSenderRulesCache();
}

/**
 * Run the TRUNCATE, retrying when Postgres aborts it as a deadlock victim.
 *
 * A test can finish while a query it started is still in flight. The builder
 * stream route is the known case: an aborted stream closes at once, but the
 * boardRevision aggregate already running finishes on its own. TRUNCATE takes
 * ACCESS EXCLUSIVE locks on dozens of tables in one order while that query
 * holds ACCESS SHARE locks it took in another, so Postgres detects a deadlock
 * (40P01) and kills the TRUNCATE. The next test then fails in beforeEach, in a
 * file the PR never touched: it red-lit CI on #875 and #876, the same test both
 * times ("pushes the board when the client's revision is behind").
 *
 * The stray query ends in milliseconds, so a short wait and a retry succeeds.
 * Only 40P01 is retried, at most three attempts, so anything else fails loudly
 * exactly as before.
 */
async function truncate(sql: string): Promise<void> {
  const ATTEMPTS = 3;
  for (let attempt = 1; ; attempt++) {
    try {
      await prisma.$executeRawUnsafe(sql);
      return;
    } catch (err) {
      if (!isDeadlock(err) || attempt >= ATTEMPTS) throw err;
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
    }
  }
}

/** Postgres "deadlock detected", however Prisma wrapped it. */
function isDeadlock(err: unknown): boolean {
  const e = err as { message?: unknown; meta?: { code?: unknown } } | null;
  return e?.meta?.code === "40P01" || /\b40P01\b/.test(String(e?.message ?? ""));
}
