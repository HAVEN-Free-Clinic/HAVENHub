-- AlterTable
ALTER TABLE "Person" ADD COLUMN     "doNotRehire" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "doNotRehireNote" TEXT,
ADD COLUMN     "doNotRehireSetAt" TIMESTAMP(3),
ADD COLUMN     "doNotRehireSetById" TEXT;
