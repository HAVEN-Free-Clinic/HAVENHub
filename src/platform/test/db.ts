import { prisma } from "@/platform/db";

/** Truncate all platform tables between tests. Test database only. */
export async function resetDb() {
  // CASCADE handles FK ordering. (RESTART IDENTITY would be a no-op: all PKs are cuid text.)
  await prisma.$executeRawUnsafe(
    `TRUNCATE "QuizAttempt", "VolunteerTraining", "Evaluation", "InterviewPanelist", "Interview", "OnboardingContract", "Acceptance", "Application", "Applicant", "FormField", "FormSection", "RecruitmentCycle",
              "ShiftRequest", "ScheduleDay", "RhdClinic", "RhdAttending",
              "ShiftAssignment", "HipaaCertificate", "RoleAssignment", "RoleGrant", "Role", "TermMembership",
              "DepartmentDelegation", "Department", "Term", "Person", "AuditLog",
              "Outbox", "MirrorRecord", "WorkerHeartbeat",
              "OffboardFlag", "EpicRequest", "YnhhTicket", "DisciplinaryAction", "EmailLog", "EmailCampaignRun", "EmailCampaign", "EmailTemplate",
              "ComplianceReminder", "MailCredential", "Setting" CASCADE`
  );
}
