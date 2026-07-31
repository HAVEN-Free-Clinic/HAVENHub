import Link from "next/link";
import { requireModuleAccess } from "@/platform/auth/session";
import { PageHeader } from "@/platform/ui/page-header";
import { Card } from "@/platform/ui/card";
import { Badge } from "@/platform/ui/badge";
import { getMyCourses } from "@/modules/learning/services/enrollment";
import { getCourseRecurrenceById } from "@/modules/learning/services/courses";

const LABEL = { COMPLETE: "Complete", IN_PROGRESS: "In progress", NOT_STARTED: "Not started" } as const;

export default async function LearningPage() {
  const person = await requireModuleAccess("learning");
  const courses = await getMyCourses(person.personId);
  const recurrenceById = await getCourseRecurrenceById(courses.map((c) => c.id));

  return (
    <>
      <PageHeader title="Learning" description="Complete the training courses assigned to your department." />
      <div className="mt-6 max-w-2xl space-y-3">
        {courses.length === 0 && (
          <p className="text-sm text-muted-foreground">You have no assigned courses right now.</p>
        )}
        {courses.map((c) => (
          <Link key={c.id} href={`/learning/${c.id}`} className="block">
            <Card interactive>
              <div className="flex items-center justify-between">
                <span className="font-medium">{c.title}</span>
                <div className="flex items-center gap-2">
                  {recurrenceById[c.id] === "PER_TERM" && <Badge>Retake each term</Badge>}
                  <Badge tone={c.status === "COMPLETE" ? "success" : "default"}>{LABEL[c.status]}</Badge>
                </div>
              </div>
              {c.description && <p className="mt-1 text-sm text-muted-foreground">{c.description}</p>}
            </Card>
          </Link>
        ))}
      </div>
    </>
  );
}
