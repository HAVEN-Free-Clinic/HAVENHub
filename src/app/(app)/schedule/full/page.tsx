import { requireModuleAccess } from "@/platform/auth/session";
import { Badge } from "@/platform/ui/badge";
import { cardClasses } from "@/platform/ui/card";
import { fullSchedule } from "@/modules/schedule/services/schedule";
import { isoDateKey } from "@/modules/schedule/engine/map";
import { displayDate } from "@/modules/schedule/engine/display";

type PageProps = {
  searchParams: Promise<{ date?: string; [key: string]: string | string[] | undefined }>;
};

export default async function FullSchedulePage({ searchParams }: PageProps) {
  await requireModuleAccess("schedule");
  const sp = await searchParams;

  const { term, clinicDates, selectedDate, departments } = await fullSchedule(sp.date);
  const selectedKey = selectedDate ? isoDateKey(selectedDate) : null;

  const selectedDisplay = selectedDate
    ? selectedDate.toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      })
    : null;

  const totalVolunteers = departments.reduce((acc, d) => acc + d.volunteers.length, 0);
  const totalDirectors = departments.reduce((acc, d) => acc + d.directors.length, 0);
  const totalShadows = departments.reduce((acc, d) => acc + d.shadows.length, 0);

  return (
    <div>
      {/* Hero */}
      <div className="rounded-2xl bg-brand px-8 py-6 text-white mb-8">
        <p className="text-xs font-semibold uppercase tracking-widest text-white/60 mb-1">Full Schedule</p>
        <h1 className="text-2xl font-bold tracking-tight">{selectedDisplay ?? "Select a date"}</h1>
        {selectedDate && departments.length > 0 && (
          <p className="text-sm text-white/70">
            {totalDirectors} director{totalDirectors !== 1 ? "s" : ""} &middot;{" "}
            {totalVolunteers} volunteer{totalVolunteers !== 1 ? "s" : ""} &middot;{" "}
            {totalShadows} shadow{totalShadows !== 1 ? "s" : ""} &middot;{" "}
            {departments.length} department{departments.length !== 1 ? "s" : ""}
          </p>
        )}
      </div>

      {!term ? (
        <p className="text-sm text-subtle-foreground">No active term.</p>
      ) : (
        <>
          {/* Date strip */}
          {clinicDates.length > 0 && (
            <nav className="mb-8 flex flex-wrap gap-2" aria-label="Schedule dates">
              {clinicDates.map((d) => {
                const key = isoDateKey(d);
                const isSelected = key === selectedKey;
                return (
<a                  
                    key={key}
                    href={`/schedule/full?date=${key}`}
                    aria-current={isSelected ? "page" : undefined}
                    className={
                      isSelected
                        ? "rounded-full px-3 py-1 text-sm font-medium bg-brand text-white"
                        : "rounded-full px-3 py-1 text-sm font-medium bg-muted-strong text-foreground-soft hover:bg-muted-strong transition-colors"
                    }
                  >
                    {displayDate(key)}
                  </a>
                );
              })}
            </nav>
          )}

          {/* Department cards */}
          {departments.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border px-6 py-10 text-center text-sm text-subtle-foreground">
              Nothing scheduled for this date.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {departments.map(({ department, directors, volunteers, shadows, conflicts }) => (
                <section
                  key={department.id}
                  className={`${cardClasses({ pad: false })} overflow-hidden`}
                >
                  {/* Card header */}
                  <div className="bg-brand px-4 py-3 flex items-center justify-between">
                    <span className="text-sm font-black uppercase tracking-widest text-white">
                      {department.code}
                    </span>
                    <div className="flex items-center gap-2 text-xs text-white/70">
                      {directors.length > 0 && <span className="bg-white/20 rounded-full px-2 py-0.5 font-medium">{directors.length} {directors.length === 1 ? "director" : "directors"}</span>}
                      {volunteers.length > 0 && <span className="bg-white/20 rounded-full px-2 py-0.5 font-medium">{volunteers.length} {volunteers.length === 1 ? "volunteer" : "volunteers"}</span>}
                      {shadows.length > 0 && <span className="bg-white/20 rounded-full px-2 py-0.5 font-medium">{shadows.length} {shadows.length === 1 ? "shadow" : "shadows"}</span>}
                    </div>
                  </div>

                  {/* Card body */}
                  <div className="px-4 py-4 flex flex-col gap-4">

                    {/* Directors */}
                    {directors.length > 0 && (
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-widest text-brand-fg/40 mb-1.5">Directors</p>
                        <ul className="flex flex-col gap-1">
                          {directors.map((p) => (
                            <li key={p.id} className="flex flex-wrap items-center gap-1.5">
                              <span className="text-sm font-bold text-foreground">{p.name}</span>
                              {(conflicts.get(p.id) ?? []).length > 0 && (
                                <Badge tone="warning" title={(conflicts.get(p.id) ?? []).join(", ")}>
                                  Also in {(conflicts.get(p.id) ?? []).join(", ")}
                                </Badge>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* Volunteers */}
                    {volunteers.length > 0 && (
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-widest text-brand-fg/40 mb-1.5">Volunteers</p>
                        <ul className="flex flex-col gap-1">
                          {volunteers.map((v) => (
                            <li key={v.id} className="flex flex-wrap items-center gap-1.5">
                              <span className="text-sm text-foreground-soft">{v.name}</span>
                              {v.tags.triage && <Badge tone="default">Triage</Badge>}
                              {v.tags.walkin && <Badge tone="default">Walk-in</Badge>}
                              {v.tags.cc && <Badge tone="default">CC</Badge>}
                              {v.tags.remote && <Badge tone="default">Remote</Badge>}
                              {(conflicts.get(v.id) ?? []).length > 0 && (
                                <Badge tone="warning" title={(conflicts.get(v.id) ?? []).join(", ")}>
                                  Also in {(conflicts.get(v.id) ?? []).join(", ")}
                                </Badge>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* Shadows */}
                    {shadows.length > 0 && (
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-widest text-brand-fg/40 mb-1.5">Shadows</p>
                        <ul className="flex flex-col gap-1">
                          {shadows.map((p) => (
                            <li key={p.id} className="flex flex-wrap items-center gap-1.5">
                              <span className="text-sm text-subtle-foreground italic">{p.name}</span>
                              {(conflicts.get(p.id) ?? []).length > 0 && (
                                <Badge tone="warning" title={(conflicts.get(p.id) ?? []).join(", ")}>
                                  Also in {(conflicts.get(p.id) ?? []).join(", ")}
                                </Badge>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {directors.length === 0 && volunteers.length === 0 && shadows.length === 0 && (
                      <p className="text-sm text-subtle-foreground italic">Nothing scheduled</p>
                    )}
                  </div>
                </section>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}