import "./globals.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Inter } from "next/font/google";
import { auth } from "@/platform/auth/auth";
import { InactivityTracker } from "@/platform/auth/inactivity";
import { getSetting } from "@/platform/settings/service";
import { brandStyleVars } from "@/platform/ui/brand-style";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

export async function generateMetadata(): Promise<Metadata> {
  const name = await getSetting<string>("branding.appName");
  return {
    title: name,
    description: `The unified platform for ${name}`,
  };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const [session, brandColor] = await Promise.all([
    auth(),
    getSetting<string>("branding.brandColor"),
  ]);

  return (
    <html lang="en">
      <body className={`${inter.variable} min-h-screen bg-slate-50 font-sans text-slate-900 antialiased`}>
        <style dangerouslySetInnerHTML={{ __html: brandStyleVars(brandColor) }} />
        <InactivityTracker authenticated={!!session?.user} />
        {children}
      </body>
    </html>
  );
}
