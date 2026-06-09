import type { ReactNode } from "react";
import Link from "next/link";
import { signOut } from "@/platform/auth/auth";
import { MODULES } from "@/platform/modules/registry";
import { getAccessibleModules } from "@/platform/modules/access";
import { HavenLogo } from "./haven-logo";
import { GlobalNav } from "./global-nav";
import { Breadcrumbs } from "./breadcrumbs";
import { BreadcrumbProvider } from "./breadcrumb-context";
import type { BreadcrumbModule } from "./breadcrumb-trail";

export async function AppShell({
  userName,
  termLabel,
  personId,
  children,
}: {
  userName: string | null;
  termLabel?: string | null;
  personId: string;
  children: ReactNode;
}) {
  const navModules = await getAccessibleModules(personId);
  const breadcrumbModules: BreadcrumbModule[] = MODULES.map((m) => ({
    id: m.id,
    title: m.title,
    nav: m.nav,
  }));

  return (
    <div className="min-h-screen flex flex-col">
      {/* Brand accent line */}
      <div className="h-0.5 bg-brand" />

      <header className="relative border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-6 h-14">
          <div className="flex items-center gap-2">
            <Link href="/" aria-label="Go to hub home" className="flex items-center hover:opacity-80 transition-opacity">
              <HavenLogo className="h-8 text-brand" />
            </Link>
            {termLabel && (
              <span className="ml-1 rounded-full bg-brand-faint px-2.5 py-0.5 text-xs font-medium text-brand">
                {termLabel}
              </span>
            )}
          </div>

          <div className="flex-1">
            <GlobalNav items={navModules} />
          </div>

          <div className="flex items-center gap-4">
            <span className="hidden text-sm text-slate-600 sm:inline">{userName}</span>
            <form
              action={async () => {
                "use server";
                await signOut({ redirectTo: "/login" });
              }}
            >
              <button
                type="submit"
                className="text-sm font-medium text-slate-500 hover:text-slate-900 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <BreadcrumbProvider>
        <Breadcrumbs modules={breadcrumbModules} />

        <main className="mx-auto w-full max-w-6xl px-6 py-10 flex-1">
          {children}
        </main>
      </BreadcrumbProvider>

      <footer className="border-t border-slate-100">
        <div className="mx-auto max-w-6xl px-6 py-8 text-xs text-slate-400">
          HAVEN Free Clinic · Yale University
        </div>
      </footer>
    </div>
  );
}
