import type { ReactNode } from "react";
import Link from "next/link";
import { signOut } from "@/platform/auth/auth";
import { MODULES } from "@/platform/modules/registry";
import { getAccessibleModules } from "@/platform/modules/access";
import { getSetting } from "@/platform/settings/service";
import { HavenLogo } from "./haven-logo";
import { GlobalNav } from "./global-nav";
import { Breadcrumbs } from "./breadcrumbs";
import { BreadcrumbProvider } from "./breadcrumb-context";
import type { BreadcrumbModule } from "./breadcrumb-trail";
import { ThemeToggle } from "./theme-toggle";
import { resolvePreference } from "./theme";
import { NotificationBell } from "./notification-bell";

/** First letters of the first and last name parts, e.g. "Maya Chen" -> "MC". */
function toInitials(name: string | null): string {
  if (!name) return "·";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "·";
  const first = parts[0][0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] ?? "" : "";
  return (first + last).toUpperCase();
}

export async function AppShell({
  userName,
  termLabel,
  personId,
  personThemePreference,
  children,
}: {
  userName: string | null;
  termLabel?: string | null;
  personId: string;
  /** Raw person preference from the session (string | null). AppShell resolves this against the admin default. */
  personThemePreference: string | null;
  children: ReactNode;
}) {
  const [navModules, themeDefault] = await Promise.all([
    getAccessibleModules(personId),
    getSetting<string>("ui.defaultTheme"),
  ]);
  const resolvedTheme = resolvePreference(personThemePreference, themeDefault);
  const breadcrumbModules: BreadcrumbModule[] = MODULES.map((m) => ({
    id: m.id,
    title: m.title,
    nav: m.nav,
  }));
  const initials = toInitials(userName);

  return (
    <div className="min-h-screen flex flex-col bg-canvas">
      {/* Floating glass nav: a transparent sticky wrapper holds a centered pill
          that detaches from the top/sides so canvas shows around it and page
          content blurs beneath it on scroll. */}
      <header className="sticky top-0 z-30 px-4 pt-3">
        <div className="glass-bar mx-auto flex max-w-6xl items-center gap-4 rounded-full h-14 px-6">
          <div className="flex items-center gap-2">
            <Link href="/" aria-label="Go to hub home" className="flex items-center hover:opacity-80 transition-opacity">
              <HavenLogo className="h-8 text-brand-fg" />
            </Link>
            {termLabel && (
              <span className="ml-1 rounded-full bg-brand-faint px-2.5 py-0.5 text-xs font-medium text-brand-fg">
                {termLabel}
              </span>
            )}
          </div>

          <div className="min-w-0 flex-1">
            <GlobalNav items={navModules} />
          </div>

          <div className="flex items-center gap-3">
            <ThemeToggle initial={resolvedTheme} />
            <NotificationBell />
            <div className="hidden items-center gap-2.5 sm:flex">
              <span
                aria-hidden
                className="grid h-8 w-8 place-items-center rounded-full bg-gradient-to-br from-brand to-brand-deep text-xs font-semibold tracking-wide text-white"
              >
                {initials}
              </span>
              {userName && (
                <span className="text-sm font-medium text-foreground-soft">{userName}</span>
              )}
            </div>
            <form
              action={async () => {
                "use server";
                await signOut({ redirectTo: "/login" });
              }}
            >
              <button
                type="submit"
                className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:border-border-strong hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
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

      <footer className="border-t border-border-subtle">
        <div className="mx-auto max-w-6xl px-6 py-8 text-xs text-subtle-foreground">
          HAVEN Free Clinic · Yale University
        </div>
      </footer>
    </div>
  );
}
