import type { ReactNode } from "react";
import Link from "next/link";
import { signOut } from "@/platform/auth/auth";
import { config } from "@/platform/config";
import { MODULES } from "@/platform/modules/registry";
import { getAccessibleModules } from "@/platform/modules/access";
import { getSetting } from "@/platform/settings/service";
import { getOrgIdentity, formatOrgLine } from "@/platform/branding/org";
import { TimeZoneProvider } from "@/platform/dates/client";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import { HavenLogo } from "./haven-logo";
import { GlobalNav } from "./global-nav";
import { Breadcrumbs } from "./breadcrumbs";
import { BreadcrumbProvider } from "./breadcrumb-context";
import type { BreadcrumbModule } from "./breadcrumb-trail";
import { ThemeToggle } from "./theme-toggle";
import { resolvePreference } from "./theme";
import { NotificationBell } from "./notification-bell";
import { AccountMenu } from "./account-menu";
import { HelpLauncher } from "./help/help-launcher";
import { CommandPalette } from "./command-palette";

export async function AppShell({
  userName,
  termLabel,
  personId,
  personThemePreference,
  extraModuleIds,
  extraNavItems,
  children,
}: {
  userName: string | null;
  termLabel?: string | null;
  personId: string;
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
  // Top-level route segment (== module id) -> human title, for the Help widget's
  // context seeding. Built here so the client never imports the server registry.
  const moduleLabels = Object.fromEntries(MODULES.map((m) => [m.id, m.title]));
  const gitbookEnabled = Boolean(config.GITBOOK_SITE_URL && config.GITBOOK_JWT_KEY);

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
              userName={userName}
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

      <footer className="border-t border-border-subtle">
        <div className="mx-auto max-w-6xl px-6 py-8 text-xs text-subtle-foreground">
          {formatOrgLine(org)}
        </div>
      </footer>

      {/* Persistent floating help bubble. Mounted OUTSIDE the glass-bar toolbar so its
          fixed positioning anchors to the viewport, not the toolbar's backdrop-filter
          containing block. Renders only when GitBook is configured. */}
      {gitbookEnabled && (
        <HelpLauncher siteURL={config.GITBOOK_SITE_URL as string} moduleLabels={moduleLabels} />
      )}
    </div>
  );
}
