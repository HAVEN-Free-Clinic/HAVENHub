"use client";
export default function OnboardError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16 text-center">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="mt-2 text-slate-500">Please try again. If the problem persists, contact HAVEN IT.</p>
      <button onClick={() => reset()} className="mt-4 rounded-md bg-slate-900 px-4 py-2 text-sm text-white">Try again</button>
    </main>
  );
}
