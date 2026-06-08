import "./globals.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Inter } from "next/font/google";
import { InactivityTracker } from "@/platform/auth/inactivity";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

export const metadata: Metadata = {
  title: "HAVEN Hub",
  description: "The unified platform for HAVEN Free Clinic",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className={`${inter.variable} min-h-screen bg-slate-50 font-sans text-slate-900 antialiased`}>
        <InactivityTracker />
        {children}
      </body>
    </html>
  );
}