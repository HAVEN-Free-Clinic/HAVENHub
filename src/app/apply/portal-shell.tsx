import type { ReactNode } from "react";
import Link from "next/link";
import { HavenLogo } from "@/platform/ui/haven-logo";
import { getSetting } from "@/platform/settings/service";
import { cx } from "@/platform/ui/cx";

async function resolveOrgName(): Promise<string> {
  try {
    return await getSetting<string>("branding.orgName");
  } catch {
    // Settings unavailable (error boundary, DB blip). Fall back to the name so
    // the shell still renders rather than crashing the whole page.
    return "HAVEN Free Clinic";
  }
}

/**
 * The shared frame for the signed-in / content pages of the public application
 * portal: a thin Yale-blue brand rule, a masthead carrying the HAVEN lockup, and
 * a centered content column. Gives every page outside the full-bleed sign-in
 * screen one consistent, official-feeling identity.
 */
export async function PortalShell({
  children,
  action,
  className,
  width = "prose",
}: {
  children: ReactNode;
  /** Optional trailing masthead control (e.g. a sign-out button). */
  action?: ReactNode;
  className?: string;
  /** Content column width. `prose` (default) is the reading column; `wide` fits the two-column wizard. */
  width?: "prose" | "wide";
}) {
  const orgName = await resolveOrgName();
  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      <div aria-hidden="true" className="h-1 w-full bg-brand" />
      <header className="border-b border-border-subtle bg-surface">
        <div className="mx-auto flex w-full max-w-2xl items-center justify-between gap-4 px-6 py-3.5">
          <Link
            href="/apply"
            aria-label={`${orgName} application portal`}
            className="flex items-center rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
          >
            <HavenLogo className="h-7 text-brand-fg" />
          </Link>
          {action}
        </div>
      </header>
      <main
        className={cx(
          "mx-auto w-full grow px-6 py-10",
          width === "wide" ? "max-w-4xl" : "max-w-2xl",
          className,
        )}
      >
        {children}
      </main>
    </div>
  );
}
