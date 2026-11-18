-- Emails to made-up recruitment test run applicants are recorded but never sent.
ALTER TYPE "EmailStatus" ADD VALUE 'SKIPPED';
