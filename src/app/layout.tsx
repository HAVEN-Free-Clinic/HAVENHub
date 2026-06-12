import "./globals.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Hanken_Grotesk } from "next/font/google";
import { auth } from "@/platform/auth/auth";
import { InactivityTracker } from "@/platform/auth/inactivity";
import { getSetting } from "@/platform/settings/service";
import { brandStyleVars } from "@/platform/ui/brand-style";
import { TopProgressBar } from "@/platform/ui/top-progress-bar";

const hanken = Hanken_Grotesk({ subsets: ["latin"], variable: "--font-hanken" });

export async function generateMetadata(): Promise<Metadata> {
  const [name, favicon] = await Promise.all([
    getSetting<string>("branding.appName"),
    getSetting<{ contentType: string; version: number }>("branding.favicon"),
  ]);
  return {
    title: name,
    description: `The unified platform for ${name}`,
    icons: { icon: `/api/branding/favicon?v=${favicon.version}` },
  };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const [session, brandColor] = await Promise.all([
    auth(),
    getSetting<string>("branding.brandColor"),
  ]);

  return (
    <html lang="en">
      <body className={`${hanken.variable} min-h-screen bg-canvas font-sans text-slate-900 antialiased`}>
        <style dangerouslySetInnerHTML={{ __html: brandStyleVars(brandColor) }} />
        <TopProgressBar />
        <InactivityTracker authenticated={!!session?.user} />
        {children}
      </body>
    </html>
  );
}
