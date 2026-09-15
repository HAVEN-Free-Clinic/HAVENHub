-- A volunteer accepted into a second department in one recruitment cycle.

-- CreateEnum
CREATE TYPE "DualAppointmentStatus" AS ENUM ('PENDING', 'APPROVED', 'DECLINED', 'CANCELLED');

-- CreateTable
CREATE TABLE "DualAppointment" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "departmentCode" TEXT NOT NULL,
    "status" "DualAppointmentStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "requestedById" TEXT NOT NULL,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DualAppointment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DualAppointment_status_idx" ON "DualAppointment"("status");

-- CreateIndex
CREATE UNIQUE INDEX "DualAppointment_applicationId_departmentCode_key" ON "DualAppointment"("applicationId", "departmentCode");

-- AddForeignKey
ALTER TABLE "DualAppointment" ADD CONSTRAINT "DualAppointment_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DualAppointment" ADD CONSTRAINT "DualAppointment_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DualAppointment" ADD CONSTRAINT "DualAppointment_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- DB backstop: an application holds at most ONE dual appointment that is still in
-- play (a pending request or an approval), because a dual appointment means two
-- departments, not three. Prisma cannot express a partial index in schema.prisma,
-- so it lives here as raw SQL. The service checks first and gives a readable
-- message; this index closes the race between two concurrent requests.
-- Guarded by src/modules/recruitment/services/dual-appointments.test.ts.
CREATE UNIQUE INDEX "DualAppointment_one_active_per_application" ON "DualAppointment"("applicationId") WHERE "status" IN ('PENDING', 'APPROVED');
