import type { Metadata } from "next";
import Link from "next/link";
import { buildPageMetadata } from "@/platform/branding/metadata";
import { CONTRIBUTORS, formatCopyright } from "@/platform/branding/attribution";
import { getSetting } from "@/platform/settings/service";
import { HavenLogo } from "@/platform/ui/haven-logo";
import { cardClasses } from "@/platform/ui/card";

export async function generateMetadata(): Promise<Metadata> {
  const appName = await getSetting<string>("branding.appName");
  const base = await buildPageMetadata({
    title: "Attributions",
    description: `The people who build and maintain ${appName}.`,
  });
  // Never indexed: this page carries real people's contact addresses.
  // buildPageMetadata returns a plain object literal with no robots key of its
  // own, so spreading it and adding robots here is not overwritten upstream.
  return { ...base, robots: { index: false, follow: false } };
}

/**
 * Public credits for the Hub itself, linked from the copyright notice in every
 * footer. Deliberately outside the (app) route group so it stays reachable from
 * the sign-in screen, the application portal, and the 404 page, none of which
 * have a session.
 */
export default async function AttributionsPage() {
  const [appName, orgName] = await Promise.all([
    getSetting<string>("branding.appName"),
    getSetting<string>("branding.orgName"),
  ]);
  const year = new Date().getFullYear();

  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      <div aria-hidden="true" className="h-1 w-full bg-brand" />
      <header className="border-b border-border-subtle bg-surface">
        <div className="mx-auto flex w-full max-w-2xl items-center px-6 py-3.5">
          <Link
            href="/"
            aria-label={`${appName} home`}
            className="flex items-center rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
          >
            <HavenLogo className="h-7 text-brand-fg" />
          </Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-2xl grow px-6 py-12">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {appName}
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Attributions</h1>
        <p className="mt-3 text-sm leading-relaxed text-foreground-soft">
          {appName} is built and maintained in-house by the {orgName} IT and
          Communications team, with direction and support from clinic leadership.
        </p>

        <h2 className="mt-10 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Contributors
        </h2>
        <ul className="mt-3 space-y-3">
          {CONTRIBUTORS.map((contributor) => (
            <li key={contributor.name} className={cardClasses()}>
              <p className="font-medium">{contributor.name}</p>
              <p className="mt-0.5 text-sm text-foreground-soft">{contributor.role}</p>
              {contributor.email ? (
                <a
                  href={`mailto:${contributor.email}`}
                  className="mt-2 inline-block rounded-sm text-sm text-brand-fg underline underline-offset-2 hover:text-brand-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                >
                  {contributor.email}
                </a>
              ) : null}
            </li>
          ))}
        </ul>

        <p className="mt-10 text-xs text-subtle-foreground">
          {formatCopyright(orgName, year)}
        </p>
      </main>
    </div>
  );
}
