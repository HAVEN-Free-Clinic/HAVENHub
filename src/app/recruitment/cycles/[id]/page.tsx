import Link from "next/link";
import { notFound } from "next/navigation";
import { getCycle } from "@/modules/recruitment/services/cycles";
import { publishCycleAction, closeCycleAction, toggleRenewalsAction } from "../../actions";

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
};

export default async function CycleOverviewPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const { error } = await searchParams;
  const cycle = await getCycle(id);
  if (!cycle) notFound();
  const applyUrl = `/apply/${cycle.publicSlug}`;
  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">{cycle.title}</h1>
        <span className="rounded bg-slate-100 px-2 py-1 text-xs">{cycle.status}</span>
      </div>
      {error && <p role="alert" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <div className="flex gap-3">
        <Link href={`/recruitment/cycles/${id}/builder`} className="rounded-md border px-3 py-1.5 text-sm">Edit form</Link>
        <Link href={`/recruitment/cycles/${id}/applicants`} className="rounded-md border px-3 py-1.5 text-sm">View applicants</Link>
      </div>
      <div className="rounded border p-4 text-sm">
        <p className="font-medium">Public link</p>
        {cycle.status === "OPEN"
          ? <a className="text-blue-700 underline" href={applyUrl}>{applyUrl}</a>
          : <p className="text-slate-500">Publish the cycle to activate {applyUrl}</p>}
      </div>
      <form action={toggleRenewalsAction.bind(null, id, !cycle.acceptsRenewals)}>
        <button className="text-sm underline">{cycle.acceptsRenewals ? "Disable" : "Enable"} renewal branch</button>
      </form>
      <div className="flex gap-3">
        {cycle.status === "DRAFT" && <form action={publishCycleAction.bind(null, id)}><button className="rounded-md bg-slate-900 px-3 py-1.5 text-sm text-white">Publish</button></form>}
        {cycle.status === "OPEN" && <form action={closeCycleAction.bind(null, id)}><button className="rounded-md border px-3 py-1.5 text-sm">Close</button></form>}
      </div>
    </div>
  );
}
