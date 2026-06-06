import { prisma } from "@/platform/db";

/** Truncate all platform tables between tests. Test database only. */
export async function resetDb() {
  // CASCADE handles FK ordering. (RESTART IDENTITY would be a no-op: all PKs are cuid text.)
  await prisma.$executeRawUnsafe(
    `TRUNCATE "RoleAssignment", "RoleGrant", "Role", "TermMembership",
              "Department", "Term", "Person", "AuditLog",
              "Outbox", "MirrorRecord", "WorkerHeartbeat" CASCADE`
  );
}
