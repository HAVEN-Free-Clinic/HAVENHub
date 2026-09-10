-- A preferred first name follows an applicant all the way to the roster.
--
-- Person gained the column in 20260909120000_person_name_parts. Without these
-- two, somebody who goes by Jack types it into the application, gets a decision
-- email addressed to Jonathan, signs a contract as Jonathan, and lands on the
-- roster as Jonathan, because the only place it could have been recorded was the
-- free-text first-name box. promoteContracts carries it across at the end.
--
-- Nullable, and null means "my first name is fine", which is most people. There
-- is nothing to backfill: no existing row ever held this value anywhere.

ALTER TABLE "Applicant" ADD COLUMN "preferredFirstName" TEXT;
ALTER TABLE "OnboardingContract" ADD COLUMN "preferredFirstName" TEXT;
