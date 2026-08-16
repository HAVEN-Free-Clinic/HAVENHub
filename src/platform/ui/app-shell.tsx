import type { ReactNode } from "react";
import Link from "next/link";
import { signOut } from "@/platform/auth/auth";
import { MODULES } from "@/platform/modules/registry";
import { getAccessibleModules } from "@/platform/modules/access";
import { getSetting } from "@/platform/settings/service";
import { getOrgIdentity } from "@/platform/branding/org";
import { TimeZoneProvider } from "@/platform/dates/client";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import { HavenLogo } from "./haven-logo";
import { AppFooter } from "./app-footer";
import { GlobalNav } from "./global-nav";
import { Breadcrumbs } from "./breadcrumbs";
import { BreadcrumbProvider } from "./breadcrumb-context";
import type { BreadcrumbModule } from "./breadcrumb-trail";
import { ThemeToggle } from "./theme-toggle";
import { resolvePreference } from "./theme";
import { NotificationBell } from "./notification-bell";
import { AccountMenu } from "./account-menu";
import { CommandPalette } from "./command-palette";

export async function AppShell({
  userName,
  termLabel,
  personId,
  photoVersion,
  personThemePreference,
  extraModuleIds,
  extraNavItems,
  children,
}: {
  userName: string | null;
  termLabel?: string | null;
  personId: string;
  /** Bumped on every photo set/removal; feeds the account menu's PersonPhoto so its
   *  cache-busting URL changes exactly when the underlying image does. */
  photoVersion: number;
  /** Raw person preference from the session (string | null). AppShell resolves this against the admin default. */
  personThemePreference: string | null;
  /** Module ids the user reaches by derived access (e.g. recruitment review scope)
   *  rather than a held permission, so the top nav matches the dashboard tiles. */
  extraModuleIds?: string[];
  /** Nav sub-items gated on dynamic conditions rather than permissions, keyed by
   *  module id (e.g. recruitment's panelist-only "My interviews"). */
  extraNavItems?: Record<string, { label: string; href: string }[]>;
  children: ReactNode;
}) {
  const [navModules, themeDefault, org, displayZone] = await Promise.all([
    getAccessibleModules(personId, new Set(extraModuleIds ?? []), extraNavItems ?? {}),
    getSetting<string>("ui.defaultTheme"),
    getOrgIdentity(),
    getDisplayTimeZone(),
  ]);
  const resolvedTheme = resolvePreference(personThemePreference, themeDefault);
  const breadcrumbModules: BreadcrumbModule[] = MODULES.map((m) => ({
    id: m.id,
    title: m.title,
    nav: m.nav,
  }));

  return (
    <div className="min-h-screen flex flex-col bg-canvas">
      {/* Skip link (WCAG 2.4.1): first focusable element, hidden until focused,
          lets keyboard users bypass the repeated global nav. */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-surface focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:shadow-lg focus:outline-2 focus:outline-offset-2 focus:outline-brand"
      >
        Skip to content
      </a>
      {/* Floating glass nav: a transparent sticky wrapper holds a centered pill
          that detaches from the top/sides so canvas shows around it and page
          content blurs beneath it on scroll. */}
      <header className="sticky top-0 z-30 px-3 pt-3 sm:px-4">
        <div className="glass-bar mx-auto flex max-w-6xl items-center gap-2 rounded-full h-14 px-3 sm:gap-4 sm:px-6">
          <div className="flex shrink-0 items-center gap-2">
            <Link href="/" aria-label="Go to hub home" className="flex items-center hover:opacity-80 transition-opacity">
              <HavenLogo className="h-8 text-brand-fg" />
            </Link>
            {/* The active-term label used to sit here. It moved to the account menu: the
                toolbar had 9px of spare width and the search trigger needs roughly 48px.
                See the Stage 2 section of the nav IA spec. */}
          </div>

          <div className="min-w-0 flex-1">
            <GlobalNav items={navModules} />
          </div>

          <div className="flex shrink-0 items-center gap-2 sm:gap-3">
            <CommandPalette items={navModules} />
            <ThemeToggle initial={resolvedTheme} />
            <NotificationBell />
            <AccountMenu
              person={{ id: personId, name: userName, photoVersion }}
              termLabel={termLabel ?? null}
              signOutAction={async () => {
                "use server";
                await signOut({ redirectTo: "/login" });
              }}
            />
          </div>
        </div>
      </header>

      <TimeZoneProvider zone={displayZone}>
        <BreadcrumbProvider>
          <Breadcrumbs modules={breadcrumbModules} />

          <main
            id="main-content"
            tabIndex={-1}
            className="mx-auto w-full max-w-6xl px-6 py-10 flex-1 outline-none"
          >
            {children}
          </main>
        </BreadcrumbProvider>
      </TimeZoneProvider>

      <AppFooter width="app" org={org} />

      {/* The GitBook help launcher used to mount here. It is retired in favour of the
          Intercom Messenger, which the (app) layout mounts and which owns the same
          bottom-right corner -- two floating AI assistants side by side was worse than
          either alone.

          Only the in-app bubble is gone. GitBook still serves docs.havenfreeclinic.org
          with adaptive access, so /api/gitbook/auth and the whole src/platform/gitbook
          layer stay live and must keep working; GITBOOK_SITE_URL and GITBOOK_JWT_KEY
          stay set. src/platform/ui/help/ is left in place rather than deleted, because
          Intercom's widget loads from widget.intercom.io and every mainstream ad blocker
          blocks it, so restoring this bubble is the fallback if too many members turn
          out to be shut out. */}
    </div>
  );
}
