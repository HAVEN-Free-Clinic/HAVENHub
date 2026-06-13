import type { ReactNode } from "react";
import { requireModuleAccess } from "@/platform/auth/session";
import { prisma } from "@/platform/db";
import { getModule } from "@/platform/modules/registry";
import { AppShell } from "@/platform/ui/app-shell";
import { ModuleNav } from "@/platform/ui/module-nav";
import { getSetting } from "@/platform/settings/service";
import { resolvePreference } from "@/platform/ui/theme";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  // Admin declares accessPermission: "admin.access", so this resolves to
  // requirePermission("admin.access"); using the registry-driven guard keeps
  // module layouts symmetric.
  const person = await requireModuleAccess("admin");
  const [activeTerm, themeDefault] = await Promise.all([
    prisma.term.findFirst({ where: { status: "ACTIVE" }, orderBy: { startDate: "desc" } }),
    getSetting<string>("ui.defaultTheme"),
  ]);
  const themePreference = resolvePreference(person.themePreference, themeDefault);
  const mod = getModule("admin")!;
  return (
    <AppShell userName={person.name} termLabel={activeTerm?.name ?? null} personId={person.personId} themePreference={themePreference}>
      <ModuleNav items={mod.nav} />
      <div className="mt-8">{children}</div>
    </AppShell>
  );
}
