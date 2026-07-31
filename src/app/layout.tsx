import "./globals.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Hanken_Grotesk } from "next/font/google";
import { cookies } from "next/headers";
import { auth } from "@/platform/auth/auth";
import { InactivityTracker } from "@/platform/auth/inactivity";
import { getSetting } from "@/platform/settings/service";
import { buildPageMetadata } from "@/platform/branding/metadata";
import { brandStyleVars } from "@/platform/ui/brand-style";
import { TopProgressBar } from "@/platform/ui/top-progress-bar";
import { EnvBanner } from "@/platform/ui/env-banner";
import { config } from "@/platform/config";
import { getPersonThemePreference } from "@/platform/ui/theme-preference";
import { ThemeListener } from "@/platform/ui/theme-listener";
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
  const [session, brandColor, adminDefault] = await Promise.all([
    auth(),
    getSetting<string>("branding.brandColor"),
    getSetting<string>("ui.defaultTheme"),
  ]);

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
        <ThemeListener />
        <RouterCrashRecovery />
        <TopProgressBar>
          <InactivityTracker authenticated={!!session?.user} />
          {children}
        </TopProgressBar>
      </body>
    </html>
  );
}
