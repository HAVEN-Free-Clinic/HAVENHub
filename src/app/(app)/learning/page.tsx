import { requireModuleAccess } from "@/platform/auth/session";
import { PageHeader } from "@/platform/ui/page-header";
import { getMyCourses } from "@/modules/learning/services/enrollment";
import { AssignedCourseCard } from "@/modules/learning/components/assigned-course-card";

export default async function LearningPage() {
  const person = await requireModuleAccess("learning");
  const courses = await getMyCourses(person.personId);

  return (
    <>
      <PageHeader title="My courses" description="Complete the training courses assigned to your department." />
      <div className="mt-6 max-w-2xl space-y-3">
        {courses.length === 0 && (
          <p className="text-sm text-muted-foreground">You have no assigned courses right now.</p>
        )}
        {courses.map((c) => (
          <AssignedCourseCard key={c.id} course={c} href={`/learning/${c.id}`} />
        ))}
      </div>
    </>
  );
}
