import Link from "next/link";
import { requirePermission } from "@/platform/auth/session";
import { PageHeader } from "@/platform/ui/page-header";
import { Button } from "@/platform/ui/button";
import { Input } from "@/platform/ui/input";
import { Card } from "@/platform/ui/card";
import { listCourses } from "@/modules/learning/services/courses";
import { createCourseAction } from "./actions";

export default async function ManageCoursesPage() {
  await requirePermission("learning.manage_courses");
  const courses = await listCourses();

  return (
    <>
      <PageHeader title="Manage courses" description="Create courses and upload their SCORM packages." />
      <div className="mt-6 max-w-2xl space-y-6">
        <form action={createCourseAction} className="flex gap-2">
          <Input name="title" placeholder="New course title" required className="flex-1" />
          <Button type="submit">Create</Button>
        </form>
        <ul className="space-y-2">
          {courses.map((c) => (
            <li key={c.id}>
              <Link href={`/learning/manage/${c.id}`} className="block">
                <Card interactive pad={false} className="flex items-center justify-between px-4 py-3">
                  <span>{c.title}</span>
                  <span className="text-xs text-muted-foreground">
                    {c.hasPackage ? "package uploaded" : "no package"}{c.isActive ? "" : " · inactive"}{c.assignToAll ? " · all depts" : ""}
                  </span>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
