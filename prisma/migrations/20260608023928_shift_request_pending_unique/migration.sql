-- DB backstop: prevents duplicate PENDING requests for the same (requester,
-- date, department) triple. Prisma cannot express partial indexes in schema.prisma,
-- so this lives here as a raw SQL guard. The service layer check inside the
-- transaction gives a friendly error first; this index is the race-window backstop.
-- Guarded by src/modules/schedule/services/schedule-schema-guards.test.ts.
-- See also: RoleAssignment comment block in schema.prisma for the same pattern.
CREATE UNIQUE INDEX "ShiftRequest_pending_unique" ON "ShiftRequest"("requesterId", "requesterDate", "departmentId") WHERE "status" = 'PENDING';
