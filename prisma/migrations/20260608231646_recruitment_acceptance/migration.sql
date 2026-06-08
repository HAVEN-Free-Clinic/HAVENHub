-- CreateTable
CREATE TABLE "Acceptance" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "departmentCode" TEXT NOT NULL,
    "approvedById" TEXT NOT NULL,
    "notes" TEXT,
    "emailedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Acceptance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Acceptance_applicationId_idx" ON "Acceptance"("applicationId");

-- CreateIndex
CREATE UNIQUE INDEX "Acceptance_applicationId_departmentCode_key" ON "Acceptance"("applicationId", "departmentCode");

-- AddForeignKey
ALTER TABLE "Acceptance" ADD CONSTRAINT "Acceptance_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Acceptance" ADD CONSTRAINT "Acceptance_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
