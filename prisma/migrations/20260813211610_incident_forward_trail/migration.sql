-- CreateTable
CREATE TABLE "IncidentForward" (
    "id" TEXT NOT NULL,
    "reportId" TEXT,
    "actionId" TEXT,
    "toEmail" TEXT NOT NULL,
    "toName" TEXT,
    "note" TEXT,
    "forwardedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IncidentForward_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IncidentForward_reportId_idx" ON "IncidentForward"("reportId");

-- CreateIndex
CREATE INDEX "IncidentForward_actionId_idx" ON "IncidentForward"("actionId");

-- A forward targets EXACTLY ONE of a report or a strike. Prisma cannot express
-- this, so it lives here, mirroring the RoleAssignment target guard. Without it
-- a bug could write a row attached to neither (invisible on both trails, a
-- disclosure with no record) or to both (counted twice).
ALTER TABLE "IncidentForward" ADD CONSTRAINT "IncidentForward_target_exactly_one"
    CHECK (("reportId" IS NOT NULL)::int + ("actionId" IS NOT NULL)::int = 1);

-- AddForeignKey
ALTER TABLE "IncidentForward" ADD CONSTRAINT "IncidentForward_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "IncidentReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidentForward" ADD CONSTRAINT "IncidentForward_actionId_fkey" FOREIGN KEY ("actionId") REFERENCES "DisciplinaryAction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidentForward" ADD CONSTRAINT "IncidentForward_forwardedById_fkey" FOREIGN KEY ("forwardedById") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
