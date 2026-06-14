import type { ReactNode } from "react";
import { requirePersonSession } from "@/platform/auth/session";
import { prisma } from "@/platform/db";
import { getModule } from "@/platform/modules/registry";
import { AppShell } from "@/platform/ui/app-shell";
import { ModuleNav } from "@/platform/ui/module-nav";

export default async function ClinicLayout({ children }: { children: ReactNode }) {
  const person = await requirePersonSession();
  const activeTerm = await prisma.term.findFirst({
    where: { status: "ACTIVE" },
    orderBy: { startDate: "desc" },
  });
  const mod = getModule("clinic")!;
  return (
    <AppShell userName={person.name} termLabel={activeTerm?.name ?? null} personId={person.personId}>
      <ModuleNav items={mod.nav} />
      <div className="mt-8">{children}</div>
    </AppShell>
  );
}
