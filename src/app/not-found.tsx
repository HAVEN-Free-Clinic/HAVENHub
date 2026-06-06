import Link from "next/link";
import { HavenLogo } from "@/platform/ui/haven-logo";

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-slate-50 p-6">
      <div className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-8 shadow-sm">
        <HavenLogo className="h-8 text-brand" />
        <p className="mt-6 text-xs font-semibold uppercase tracking-wider text-slate-400">
          Error 404
        </p>
        <h1 className="mt-1 text-xl font-semibold tracking-tight">Page not found</h1>
        <p className="mt-3 text-sm leading-relaxed text-slate-600">
          That page doesn&apos;t exist, or it may have moved. If you followed a
          link from inside the clinic, let the IT team know so we can fix it.
        </p>
        <Link
          href="/"
          className="mt-6 inline-block rounded-md bg-brand px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-hover"
        >
          Back to Hub
        </Link>
      </div>
      <p className="mt-6 text-xs text-slate-400">HAVEN Free Clinic · Yale University</p>
    </main>
  );
}
