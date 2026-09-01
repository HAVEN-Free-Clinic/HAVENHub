import { prisma } from "@/platform/db";
import { _resetSettingsCache } from "@/platform/settings/service";
import { _resetSenderRulesCache } from "@/platform/email/sender-rules";

/** Truncate all platform tables between tests. Test database only. */
export async function resetDb() {
  // CASCADE handles FK ordering. (RESTART IDENTITY would be a no-op: all PKs are cuid text.)
  // The Historical* tables are named explicitly even though CASCADE would reach
  // them through their optional Person FK: that reach is an accident of the
  // relation existing, and it would silently stop working the day a historical
  // identity stops pointing at Person at all.
  await prisma.$executeRawUnsafe(
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
              "HistoricalInterest", "HistoricalApplication", "HistoricalApplicantEmail", "HistoricalApplicant" CASCADE`
  );
  // The settings resolver holds a process-global 30s in-memory cache. We just
  // truncated "Setting", so any cached override is now stale -- clear it so a
  // setSetting in one test file cannot leak into another file's getSetting.
  _resetSettingsCache();
  // The sender-rule resolver holds a process-global cache; we just truncated
  // "EmailSenderRule", so clear it to avoid cross-test leakage.
  _resetSenderRulesCache();
}
