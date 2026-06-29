-- AlterEnum: add DRAFT value (must run outside a transaction on older Postgres)
ALTER TYPE "ApplicationStatus" ADD VALUE 'DRAFT';
