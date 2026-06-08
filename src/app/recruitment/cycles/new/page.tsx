import { prisma } from "@/platform/db";
import { createCycleAction } from "../../actions";

export default async function NewCyclePage() {
  const terms = await prisma.term.findMany({ orderBy: { startDate: "desc" } });
  return (
    <div className="max-w-lg">
      <h1 className="text-2xl font-semibold tracking-tight">New recruitment cycle</h1>
      <form action={createCycleAction} className="mt-6 space-y-4">
        <label className="block text-sm">Title<input name="title" required className="mt-1 w-full rounded border px-2 py-1" /></label>
        <label className="block text-sm">Track
          <select name="track" className="mt-1 w-full rounded border px-2 py-1"><option value="VOLUNTEER">Volunteer</option><option value="DIRECTOR">Director</option></select>
        </label>
        <label className="block text-sm">Term
          <select name="termId" required className="mt-1 w-full rounded border px-2 py-1">{terms.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
        </label>
        <label className="block text-sm">Public slug (optional)<input name="publicSlug" className="mt-1 w-full rounded border px-2 py-1" placeholder="auto from title" /></label>
        <label className="block text-sm">Departments (comma-separated codes)<input name="departments" className="mt-1 w-full rounded border px-2 py-1" placeholder="SRHD, MDIC" /></label>
        <button type="submit" className="rounded-md bg-slate-900 px-3 py-1.5 text-sm text-white">Create &amp; build form</button>
      </form>
    </div>
  );
}
