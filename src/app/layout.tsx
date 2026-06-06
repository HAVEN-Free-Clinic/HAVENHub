import "./globals.css";
import type { ReactNode } from "react";

export const metadata = {
  title: "HAVENHub",
  description: "HAVEN Free Clinic — unified platform",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">
        {children}
      </body>
    </html>
  );
}
