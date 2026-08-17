-- Trimmed by hand from `prisma migrate diff`, which also folded in pre-existing
-- drift unrelated to this change (Training/VolunteerTraining constraint renames,
-- an Application.subcommitteeRanking default). Those belong to whichever change
-- introduced them.

-- CreateTable
CREATE TABLE "TriageChatPreset" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameTemplate" TEXT NOT NULL,
    "messageTemplate" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TriageChatPreset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TriageChatPresetDepartment" (
    "id" TEXT NOT NULL,
    "presetId" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,

    CONSTRAINT "TriageChatPresetDepartment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TriageChat" (
    "id" TEXT NOT NULL,
    "presetId" TEXT NOT NULL,
    "termId" TEXT NOT NULL,
    "clinicDate" TIMESTAMP(3) NOT NULL,
    "topic" TEXT NOT NULL,
    "graphChatId" TEXT NOT NULL,
    "webUrl" TEXT NOT NULL,
    "messagePostedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TriageChat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TriageChatMember" (
    "id" TEXT NOT NULL,
    "triageChatId" TEXT NOT NULL,
    "personId" TEXT,
    "personName" TEXT NOT NULL,
    "departmentName" TEXT NOT NULL,
    "addedOk" BOOLEAN NOT NULL,
    "error" TEXT,

    CONSTRAINT "TriageChatMember_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TriageChatPreset_isActive_order_idx" ON "TriageChatPreset"("isActive", "order");

-- CreateIndex
CREATE INDEX "TriageChatPresetDepartment_departmentId_idx" ON "TriageChatPresetDepartment"("departmentId");

-- CreateIndex
CREATE UNIQUE INDEX "TriageChatPresetDepartment_presetId_departmentId_key" ON "TriageChatPresetDepartment"("presetId", "departmentId");

-- CreateIndex
CREATE INDEX "TriageChat_termId_clinicDate_idx" ON "TriageChat"("termId", "clinicDate");

-- CreateIndex
CREATE UNIQUE INDEX "TriageChat_presetId_clinicDate_key" ON "TriageChat"("presetId", "clinicDate");

-- CreateIndex
CREATE INDEX "TriageChatMember_triageChatId_idx" ON "TriageChatMember"("triageChatId");

-- CreateIndex
CREATE INDEX "TriageChatMember_personId_idx" ON "TriageChatMember"("personId");

-- AddForeignKey
ALTER TABLE "TriageChatPresetDepartment" ADD CONSTRAINT "TriageChatPresetDepartment_presetId_fkey" FOREIGN KEY ("presetId") REFERENCES "TriageChatPreset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TriageChatPresetDepartment" ADD CONSTRAINT "TriageChatPresetDepartment_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TriageChat" ADD CONSTRAINT "TriageChat_presetId_fkey" FOREIGN KEY ("presetId") REFERENCES "TriageChatPreset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TriageChat" ADD CONSTRAINT "TriageChat_termId_fkey" FOREIGN KEY ("termId") REFERENCES "Term"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TriageChat" ADD CONSTRAINT "TriageChat_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TriageChatMember" ADD CONSTRAINT "TriageChatMember_triageChatId_fkey" FOREIGN KEY ("triageChatId") REFERENCES "TriageChat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TriageChatMember" ADD CONSTRAINT "TriageChatMember_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;
