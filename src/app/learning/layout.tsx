import type { ReactNode } from "react";
import { requireModuleAccess } from "@/platform/auth/session";
import { getModule } from "@/platform/modules/registry";
import { AppShell } from "@/platform/ui/app-shell";
import { ModuleNav } from "@/platform/ui/module-nav";

export default async function LearningLayout({ children }: { children: ReactNode }) {
  const person = await requireModuleAccess("learning");
  const mod = getModule("learning")!;
  return (
    <AppShell userName={person.name} personId={person.personId}>
      <ModuleNav items={mod.nav} />
      <div className="mt-8">{children}</div>
    </AppShell>
  );
}
