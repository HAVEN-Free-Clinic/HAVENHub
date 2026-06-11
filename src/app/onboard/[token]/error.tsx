"use client";
import { Button } from "@/platform/ui/button";
export default function OnboardError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16 text-center">
      <h1 className="text-xl font-bold">Something went wrong</h1>
      <p className="mt-2 text-slate-500">Please try again. If the problem persists, contact HAVEN IT.</p>
      <Button onClick={() => reset()} className="mt-4">Try again</Button>
    </main>
  );
}
