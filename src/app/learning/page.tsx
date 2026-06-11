import Link from "next/link";
import { requireModuleAccess } from "@/platform/auth/session";
import { PageHeader } from "@/platform/ui/page-header";
import { getMyCourses } from "@/modules/learning/services/enrollment";

const LABEL = { COMPLETE: "Complete", IN_PROGRESS: "In progress", NOT_STARTED: "Not started" } as const;

export default async function LearningPage() {
  const person = await requireModuleAccess("learning");
  const courses = await getMyCourses(person.personId);

  return (
    <>
      <PageHeader title="Learning" description="Complete the training courses assigned to your department." />
      <div className="mt-6 max-w-2xl space-y-3">
        {courses.length === 0 && (
          <p className="text-sm text-slate-500">You have no assigned courses right now.</p>
        )}
        {courses.map((c) => (
          <Link
            key={c.id}
            href={`/learning/${c.id}`}
            className="block rounded border border-slate-200 px-4 py-3 hover:border-slate-400"
          >
            <div className="flex items-center justify-between">
              <span className="font-medium">{c.title}</span>
              <span
                className={
                  c.status === "COMPLETE"
                    ? "rounded bg-green-50 px-2 py-0.5 text-xs text-green-800"
                    : "rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600"
                }
              >
                {LABEL[c.status]}
              </span>
            </div>
            {c.description && <p className="mt-1 text-sm text-slate-500">{c.description}</p>}
          </Link>
        ))}
      </div>
    </>
  );
}
