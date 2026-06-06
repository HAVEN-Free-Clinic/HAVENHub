import type { ReactNode } from "react";
import Link from "next/link";
import { signOut } from "@/platform/auth/auth";

export function AppShell({
  userName,
  children,
}: {
  userName: string | null;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3">
          <Link href="/hub" className="text-lg font-semibold">
            HAVENHub
          </Link>
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
                className="text-sm text-slate-500 underline-offset-4 hover:underline"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
    </div>
  );
}
