import type { ReactNode } from "react";
import Link from "next/link";
import { signOut } from "@/platform/auth/auth";
import { HavenMark } from "./haven-mark";

export function AppShell({
  userName,
  termLabel,
  children,
}: {
  userName: string | null;
  termLabel?: string | null;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen flex flex-col">
      {/* Brand accent line */}
      <div className="h-0.5 bg-brand" />

      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 h-14">
          <div className="flex items-center gap-2">
            <Link href="/hub" className="flex items-center gap-2 hover:opacity-80 transition-opacity">
              <HavenMark className="h-7 w-auto text-brand" />
              <span className="font-semibold tracking-tight">HAVEN Hub</span>
            </Link>
            {termLabel && (
              <span className="ml-1 rounded-full bg-brand-faint px-2.5 py-0.5 text-xs font-medium text-brand">
                {termLabel}
              </span>
            )}
          </div>
          <div className="flex items-center gap-4">
            <span className="text-sm text-slate-600">{userName}</span>
            <form
              action={async () => {
                "use server";
                await signOut({ redirectTo: "/login" });
              }}
            >
              <button
                type="submit"
                className="text-sm font-medium text-slate-500 hover:text-slate-900 transition-colors"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl px-6 py-10 flex-1">
        {children}
      </main>

      <footer className="border-t border-slate-100">
        <div className="mx-auto max-w-6xl px-6 py-8 text-xs text-slate-400">
          HAVEN Free Clinic · Yale University
        </div>
      </footer>
    </div>
  );
}
