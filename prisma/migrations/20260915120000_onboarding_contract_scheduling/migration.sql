-- Onboarding contract refresh: a legal middle name to match the structured
-- Person name, the two scheduling answers (preferred shift count, and a request
-- to change the availability given on the application) that the schedule
-- builder shows directors, and the required profile photo.
--
-- Five nullable columns with no default, so the release still serving during
-- `prisma migrate deploy` is unaffected: it never writes them and its client
-- does not select them.

-- AlterTable
ALTER TABLE "OnboardingContract" ADD COLUMN     "availabilityChangeNeeded" BOOLEAN,
ADD COLUMN     "availabilityChangeRequest" TEXT,
ADD COLUMN     "legalMiddleName" TEXT,
ADD COLUMN     "photoStoredName" TEXT,
ADD COLUMN     "shiftsWanted" TEXT;
