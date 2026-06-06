import { prisma } from "@/platform/db";

/** Truncate all platform tables between tests. Test database only. */
export async function resetDb() {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "RoleAssignment", "RoleGrant", "Role", "TermMembership",
              "Department", "Term", "Person", "AuditLog"
     RESTART IDENTITY CASCADE`
  );
}
