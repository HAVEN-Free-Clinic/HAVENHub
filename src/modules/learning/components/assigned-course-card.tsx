import Link from "next/link";
import { Card } from "@/platform/ui/card";
import { Badge } from "@/platform/ui/badge";
import type { MyCourseRow } from "../services/enrollment";

/**
 * One row in a member's assigned-course list.
 *
 * The same list is drawn twice: /learning for a cleared member, and
 * /get-started/learning for one still working through the onboarding gate. They
 * had byte-identical status label maps and near-identical markup, and they had
 * drifted in the one place it mattered: only /learning badged a course as
 * "Retake each term". /learning is closed to a member behind the gate, so the
 * fact was missing from the only list they can actually read while taking the
 * courses.
 *
 * No "use client": both hosts are server components, so no hooks and no refs
 * here. The card owns its classes and takes no className, so there is nothing
 * for a caller to fight.
 */

const STATUS_LABEL = {
  COMPLETE: "Complete",
  IN_PROGRESS: "In progress",
  NOT_STARTED: "Not started",
} as const;

export function AssignedCourseCard({ course, href }: { course: MyCourseRow; href: string }) {
  return (
    <Link href={href} className="block">
      <Card interactive>
        <div className="flex items-center justify-between gap-3">
          <span className="font-medium text-foreground">{course.title}</span>
          <div className="flex items-center gap-2">
            {course.recurrence === "PER_TERM" && <Badge>Retake each term</Badge>}
            <Badge tone={course.status === "COMPLETE" ? "success" : "default"}>
              {STATUS_LABEL[course.status]}
            </Badge>
          </div>
        </div>
        {course.description && (
          <p className="mt-1 text-sm text-muted-foreground">{course.description}</p>
        )}
      </Card>
    </Link>
  );
}
