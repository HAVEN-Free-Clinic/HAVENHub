import Link from "next/link";
import { requirePersonSession } from "@/platform/auth/session";
import { getEffectivePermissions, hasPermission } from "@/platform/rbac/engine";
import { MODULES } from "@/platform/modules/registry";
import { AppShell } from "@/platform/ui/app-shell";
import { prisma } from "@/platform/db";
import { getCurrentClinicChannelLink } from "@/platform/teams/channel-link";

/**
 * The hub lives at the root: the deployed domain is hub.havenfreeclinic.org,
 * so "/" is the landing page for signed-in members. Unauthenticated visitors
 * are redirected to /login by requirePersonSession.
 */
export default async function HubPage() {
  const person = await requirePersonSession();
  // One permission fetch per render; tiles filter in memory (never can() in a loop).
  const permissions = await getEffectivePermissions(person.personId);
  const activeTerm = await prisma.term.findFirst({
    where: { status: "ACTIVE" },
    orderBy: { startDate: "desc" },
  });
  const clinicChannel = await getCurrentClinicChannelLink();

  const visible = MODULES.filter(
    (m) =>
      m.status === "coming-soon" || // roadmap is visible to everyone (spec §8)
      !m.accessPermission || // open to any signed-in matched person (e.g. my-info)
      hasPermission(permissions, m.accessPermission)
  );

  return (
    <AppShell userName={person.name} termLabel={activeTerm?.name ?? null}>
      <h1 className="text-2xl font-semibold tracking-tight">
        Welcome{person.name ? `, ${person.name}` : ""}
      </h1>
      <p className="mt-1 text-sm text-slate-500">
        HAVEN Free Clinic{activeTerm ? ` · ${activeTerm.name}` : ""}
      </p>

      {clinicChannel ? (
        <a
          href={clinicChannel.webUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-6 flex items-center justify-between rounded-lg border border-brand/30 bg-brand-faint p-4 transition hover:border-brand/50 hover:shadow-sm"
        >
          <span>
            <span className="block text-xs font-semibold uppercase tracking-wider text-brand">
              This week&apos;s clinic Teams channel
            </span>
            <span className="mt-0.5 block text-sm font-medium text-slate-700">
              {clinicChannel.displayName}
            </span>
          </span>
          <span aria-hidden className="text-brand">
            &rarr;
          </span>
        </a>
      ) : null}

      <h2 className="mt-10 text-xs font-semibold uppercase tracking-wider text-slate-400">
        Modules
      </h2>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {visible.map((m) => {
          const Icon = m.icon;

          if (m.status === "active") {
            return (
              <Link
                key={m.id}
                href={`/${m.id}`}
                aria-label={`Open ${m.title}`}
                className="block rounded-lg border border-slate-200 bg-white p-5 transition hover:border-brand/40 hover:shadow-sm"
              >
                <div className="flex h-10 w-10 items-center justify-center rounded-md bg-brand-faint">
                  <Icon aria-hidden className="h-5 w-5 text-brand" />
                </div>
                <p className="mt-4 font-medium">{m.title}</p>
                <p className="mt-1 text-sm leading-relaxed text-slate-500">{m.description}</p>
              </Link>
            );
          }

          return (
            <div
              key={m.id}
              className="rounded-lg border border-slate-200 bg-white p-5"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-md bg-slate-100">
                <Icon aria-hidden className="h-5 w-5 text-slate-400" />
              </div>
              <div className="mt-4 flex items-center gap-2">
                <p className="font-medium text-slate-600">{m.title}</p>
                <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                  Coming soon
                </span>
              </div>
              <p className="mt-1 text-sm leading-relaxed text-slate-400">{m.description}</p>
            </div>
          );
        })}
      </div>
    </AppShell>
  );
}
