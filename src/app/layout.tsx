import "./globals.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Hanken_Grotesk } from "next/font/google";
import { cookies, headers } from "next/headers";
import { auth } from "@/platform/auth/auth";
import { InactivityTracker } from "@/platform/auth/inactivity";
import { getSetting } from "@/platform/settings/service";
import { buildPageMetadata } from "@/platform/branding/metadata";
import { brandStyleVars } from "@/platform/ui/brand-style";
import { TopProgressBar } from "@/platform/ui/top-progress-bar";
import { EnvBanner } from "@/platform/ui/env-banner";
import { MaintenanceBanner } from "@/platform/maintenance/maintenance-banner";
import { config } from "@/platform/config";
import { getPersonThemePreference } from "@/platform/ui/theme-preference";
import { ThemeListener } from "@/platform/ui/theme-listener";
import { ToastProvider, ToastViewport } from "@/platform/ui/toast/toast";
import { FlashReader } from "@/platform/ui/toast/flash-reader";
import { hostFromUrl } from "@/modules/recruitment/services/portal-routing";
import { RouterCrashRecovery } from "@/platform/posthog/router-crash-recovery";
import {
  resolvePreference,
  buildNoFlashScript,
  THEME_COOKIE,
  type ThemePreference,
} from "@/platform/ui/theme";

const hanken = Hanken_Grotesk({ subsets: ["latin"], variable: "--font-hanken" });

export async function generateMetadata(): Promise<Metadata> {
  const [base, favicon] = await Promise.all([
    buildPageMetadata(),
    getSetting<{ contentType: string; version: number }>("branding.favicon"),
  ]);
  return { ...base, icons: { icon: `/api/branding/favicon?v=${favicon.version}` } };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const [session, brandColor, adminDefault, maintenanceEnabled, requestHeaders] = await Promise.all([
    auth(),
    getSetting<string>("branding.brandColor"),
    getSetting<string>("ui.defaultTheme"),
    getSetting<boolean>("maintenance.enabled"),
    headers(),
  ]);

  // Resolved once, server-side, exactly like src/proxy.ts's own portal-host
  // check: the applicant portal (apply.havenfreeclinic.org) rewrites its
  // clean URLs onto /apply/* without ever changing the browser's URL, so
  // FlashReader's usePathname() can't see the rewrite on its own. Threading
  // just this boolean down (not the host string, not config.PORTAL_BASE_URL
  // itself) keeps every other env var config.ts validates out of the client
  // bundle. See flash.ts's "applicant portal host" doc section.
  const portalHost = hostFromUrl(config.PORTAL_BASE_URL);
  const isPortalHost = portalHost !== null && requestHeaders.get("host") === portalHost;

  // The maintenance page says all this at full size, so the strip would only
  // repeat itself there. proxy.ts stamps x-pathname on every request.
  const showMaintenanceBanner =
    maintenanceEnabled && requestHeaders.get("x-pathname") !== "/maintenance";

  // Person preference wins; cookie is a fast hint when there is no session. The
  // lookup runs before the page's own requirePersonSession so the <html> class
  // (no-flash dark mode) is set before any content renders. It degrades to the
  // admin default (personPref null) if the DB is briefly unreachable, so a Neon
  // blip on this every-render path cannot 500 the whole authenticated app.
  let personPref: string | null = null;
  if (session?.personId) {
    personPref = await getPersonThemePreference(session.personId);
  } else {
    personPref = (await cookies()).get(THEME_COOKIE)?.value ?? null;
  }

  const pref: ThemePreference = resolvePreference(personPref, adminDefault);
  // Explicit light/dark render the class now (zero flash); system is resolved
  // before paint by the inline script against the OS.
  const htmlClass = pref === "dark" ? "dark" : "";

  return (
    // data-theme-pref must match THEME_ATTR in theme.ts
    <html lang="en" className={htmlClass} suppressHydrationWarning data-theme-pref={pref}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: buildNoFlashScript() }} />
      </head>
      <body className={`${hanken.variable} min-h-screen bg-canvas font-sans text-foreground antialiased`}>
        <style dangerouslySetInnerHTML={{ __html: brandStyleVars(brandColor) }} />
        <EnvBanner label={config.ENV_BANNER_LABEL} />
        <MaintenanceBanner enabled={showMaintenanceBanner} />
        <ThemeListener />
        <RouterCrashRecovery />
        {/* ToastProvider wraps the whole tree (not just the viewport) so any
            page can call useToast() directly. Mounted here in the ROOT
            layout, not AppShell: flash params exist on /login, /apply, and
            /get-started, none of which AppShell wraps. FlashReader and
            ToastViewport are siblings of TopProgressBar/children, floating
            independently of whatever the current page renders, exactly like
            HelpLauncher already does outside app-shell.tsx's glass-bar toolbar
            (backdrop-filter breaks `fixed` descendants; the root layout sits
            outside every glass container by construction).

            InactivityTracker renders INSIDE ToastViewport rather than beside
            it, so its warning is a flex child directly above the toast stack.
            That is what makes the R12 fix hold: the two cannot overlap because
            they are in one flow, not because an offset was computed to keep
            them apart. */}
        <ToastProvider>
          <TopProgressBar>{children}</TopProgressBar>
          <FlashReader isPortalHost={isPortalHost} />
          <ToastViewport>
            <InactivityTracker authenticated={!!session?.user} />
          </ToastViewport>
        </ToastProvider>
      </body>
    </html>
  );
}
