"use client";
import { Button } from "@/platform/ui/button";
import { PortalNotice } from "../portal-notice";

export default function ApplyError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      <div aria-hidden="true" className="h-1 w-full bg-brand" />
      <main className="mx-auto flex w-full max-w-2xl grow items-center px-6 py-16">
        <PortalNotice
          tone="error"
          title="Something went wrong"
          action={<Button size="lg" onClick={() => reset()}>Try again</Button>}
        >
          <p>Please try again. If the problem persists, contact the HAVEN IT team.</p>
        </PortalNotice>
      </main>
    </div>
  );
}
