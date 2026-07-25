-- Freeze the onboarding contract visibility context at submit time (#107/#108/#109).
ALTER TABLE "OnboardingContract" ADD COLUMN "reviewContext" JSONB;
