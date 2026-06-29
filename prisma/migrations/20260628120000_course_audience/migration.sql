-- Add a per-course audience so a course can target directors, volunteers, or
-- everyone, composed with the existing department / assignToAll scoping.
-- Default EVERYONE preserves current behavior for all existing courses.
CREATE TYPE "CourseAudience" AS ENUM ('EVERYONE', 'DIRECTORS', 'VOLUNTEERS');
ALTER TABLE "Course" ADD COLUMN "audience" "CourseAudience" NOT NULL DEFAULT 'EVERYONE';
