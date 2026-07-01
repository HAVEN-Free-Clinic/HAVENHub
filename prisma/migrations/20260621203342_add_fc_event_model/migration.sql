-- CreateTable
CREATE TABLE "FCEvent" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "status" "FCStatus" NOT NULL,
    "effectiveAt" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,
    "enteredById" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FCEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FCEvent_patientId_effectiveAt_idx" ON "FCEvent"("patientId", "effectiveAt");

-- AddForeignKey
ALTER TABLE "FCEvent" ADD CONSTRAINT "FCEvent_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FCEvent" ADD CONSTRAINT "FCEvent_enteredById_fkey" FOREIGN KEY ("enteredById") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;
