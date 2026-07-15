-- Carry onboarding-collected member data onto the Person so it is not lost at promotion.
ALTER TABLE "Person" ADD COLUMN "dateOfBirth" TIMESTAMP(3);
ALTER TABLE "Person" ADD COLUMN "dietaryRestrictions" TEXT;
