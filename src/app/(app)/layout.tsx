import type { ReactNode } from "react";
import { requirePersonSession } from "@/platform/auth/session";
import { prisma } from "@/platform/db";
import { AppShell } from "@/platform/ui/app-shell";

/**
 * Shared shell for every authenticated route. Owns the toolbar (AppShell) so it
 * mounts once and persists across cross-module navigation: only the page body
 * (and a module's own ModuleNav) reload on a tab switch. Public routes (login,
 * apply, onboard, welcome, get-started) live outside this group and keep their
 * own chrome.
 */
export default async function AppGroupLayout({ children }: { children: ReactNode }) {
  const person = await requirePersonSession();
  const activeTerm = await prisma.term.findFirst({
    where: { status: "ACTIVE" },
    orderBy: { startDate: "desc" },
  });
  return (
    <AppShell
      userName={person.name}
      termLabel={activeTerm?.name ?? null}
      personId={person.personId}
    >
      {children}
    </AppShell>
  );
}
