import { prisma } from "@/platform/db";
import { _resetSettingsCache } from "@/platform/settings/service";
import { _resetSenderRulesCache } from "@/platform/email/sender-rules";

/** Truncate all platform tables between tests. Test database only. */
export async function resetDb() {
  // CASCADE handles FK ordering. (RESTART IDENTITY would be a no-op: all PKs are cuid text.)
  await prisma.$executeRawUnsafe(
    `TRUNCATE "EhsCompletion", "EhsTraining", "CourseProgress", "CourseDepartment", "Course",
              "QuizAttempt", "Training", "Evaluation", "InterviewPanelist", "Interview", "OnboardingContract", "Acceptance", "Application", "Applicant", "Subcommittee", "FormField", "FormSection", "RecruitmentCycleEmail", "RecruitmentCycle",
              "ShiftRequest", "ScheduleDay", "RhdClinic", "RhdAttending",
              "ShiftAssignment", "HipaaCertificate", "RoleAssignment", "RoleGrant", "Role", "TermMembership",
              "DepartmentDelegation", "Department", "Term", "Person", "AuditLog",
              "OffboardFlag", "EpicRequest", "YnhhTicket", "DisciplinaryAction", "Notification", "EmailLog", "EmailCampaignRun", "EmailCampaign", "EmailTemplate",
              "ComplianceReminder", "MailCredential", "Setting", "EmailSenderRule",
              "ApplicantPortalToken" CASCADE`
  );
  // The settings resolver holds a process-global 30s in-memory cache. We just
  // truncated "Setting", so any cached override is now stale -- clear it so a
  // setSetting in one test file cannot leak into another file's getSetting.
  _resetSettingsCache();
  // The sender-rule resolver holds a process-global cache; we just truncated
  // "EmailSenderRule", so clear it to avoid cross-test leakage.
  _resetSenderRulesCache();
}
