import type { ReactNode } from "react";
import { requireModuleAccess } from "@/platform/auth/session";
import { getModule } from "@/platform/modules/registry";
import { AppShell } from "@/platform/ui/app-shell";
import { ModuleNav } from "@/platform/ui/module-nav";
import { getSetting } from "@/platform/settings/service";
import { resolvePreference } from "@/platform/ui/theme";

export default async function LearningLayout({ children }: { children: ReactNode }) {
  const person = await requireModuleAccess("learning");
  const themeDefault = await getSetting<string>("ui.defaultTheme");
  const themePreference = resolvePreference(person.themePreference, themeDefault);
  const mod = getModule("learning")!;
  return (
    <AppShell userName={person.name} personId={person.personId} themePreference={themePreference}>
      <ModuleNav items={mod.nav} />
      <div className="mt-8">{children}</div>
    </AppShell>
  );
}
