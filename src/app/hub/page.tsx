import Link from "next/link";
import { requirePersonSession } from "@/platform/auth/session";
import { getEffectivePermissions, hasPermission } from "@/platform/rbac/engine";
import { MODULES } from "@/platform/modules/registry";
import { AppShell } from "@/platform/ui/app-shell";

export default async function HubPage() {
  const person = await requirePersonSession();
  // One permission fetch per render; tiles filter in memory (never can() in a loop).
  const permissions = await getEffectivePermissions(person.personId);

  const visible = MODULES.filter(
    (m) =>
      m.status === "coming-soon" || // roadmap is visible to everyone (spec §8)
      hasPermission(permissions, m.accessPermission)
  );

  return (
    <AppShell userName={person.name}>
      <h1 className="text-2xl font-semibold">Welcome{person.name ? `, ${person.name}` : ""}</h1>
      <p className="mt-1 text-sm text-slate-500">HAVEN Free Clinic</p>
      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {visible.map((m) => {
          const Icon = m.icon;
          const card = (
            <div
              className={`rounded-2xl border p-5 transition ${
                m.status === "active"
                  ? "border-slate-200 bg-white shadow-sm hover:border-blue-300 hover:shadow"
                  : "border-dashed border-slate-200 bg-slate-50 opacity-60"
              }`}
            >
              <Icon className="h-6 w-6 text-blue-700" />
              <div className="mt-3 flex items-center gap-2">
                <h2 className="font-medium">{m.title}</h2>
                {m.status === "coming-soon" && (
                  <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-600">
                    Coming soon
                  </span>
                )}
              </div>
              <p className="mt-1 text-sm text-slate-500">{m.description}</p>
            </div>
          );
          return m.status === "active" ? (
            <Link key={m.id} href={`/${m.id}`}>
              {card}
            </Link>
          ) : (
            <div key={m.id}>{card}</div>
          );
        })}
      </div>
    </AppShell>
  );
}
