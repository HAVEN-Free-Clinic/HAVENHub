-- AlterEnum
-- A display-only content block inside an application section. Replaces the
-- workaround of authoring a whole FormSection whose title is the notice text,
-- which the apply wizard rendered as its own empty step (deriveSteps pushes
-- every visible section) -- applicants clicked "Next" through a page holding a
-- heading and nothing else.
ALTER TYPE "FieldType" ADD VALUE 'NOTICE';
