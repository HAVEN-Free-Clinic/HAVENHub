import { requireModuleAccess } from "@/platform/auth/session";
import { PageHeader } from "@/platform/ui/page-header";
import { Badge } from "@/platform/ui/badge";
import { fullSchedule } from "@/modules/schedule/services/schedule";
import { isoDateKey } from "@/modules/schedule/engine/map";
import { displayDate } from "@/modules/schedule/engine/display";

// ---------------------------------------------------------------------------
// Page props
// ---------------------------------------------------------------------------

type PageProps = {
  searchParams: Promise<{ date?: string; [key: string]: string | string[] | undefined }>;
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function FullSchedulePage({ searchParams }: PageProps) {
  await requireModuleAccess("schedule");
  const sp = await searchParams;

  const { term, clinicDates, selectedDate, departments } = await fullSchedule(
    sp.date
  );

  const selectedKey = selectedDate ? isoDateKey(selectedDate) : null;

  return (
    <div>
      <PageHeader
        title="Full Schedule"
        description="Clinic-wide schedule by date and department"
      />

      {!term ? (
        <p className="mt-8 text-sm text-slate-400">No active term.</p>
      ) : (
        <>
          {/* Date tab strip */}
          {clinicDates.length > 0 && (
            <nav className="mt-6 flex flex-wrap gap-2" aria-label="Schedule dates">
              {clinicDates.map((d) => {
                const key = isoDateKey(d);
                const isSelected = key === selectedKey;
                return (
                  <a
                    key={key}
                    href={`/schedule/full?date=${key}`}
                    className={
                      isSelected
                        ? "rounded-full px-3 py-1 text-sm font-medium bg-brand text-white"
                        : "rounded-full px-3 py-1 text-sm font-medium bg-slate-100 text-slate-600 hover:bg-slate-200 transition-colors"
                    }
                  >
                    {displayDate(key)}
                  </a>
                );
              })}
            </nav>
          )}

          {/* Department sections */}
          <div className="mt-8">
            {departments.length === 0 ? (
              <p className="text-sm text-slate-400">
                Nothing scheduled for this date.
              </p>
            ) : (
              <div className="flex flex-col gap-10">
                {departments.map(({ department, directors, volunteers, shadows, conflicts }) => (
                  <section key={department.id}>
                    <h2 className="mb-3 text-base font-semibold">
                      {department.code} &middot; {department.name}
                    </h2>

                    {/* Directors */}
                    <div className="mb-2 text-sm">
                      <span className="font-medium text-slate-600">Directors: </span>
                      {directors.length === 0 ? (
                        <span className="text-slate-400">None</span>
                      ) : (
                        directors.map((p, i) => (
                          <span key={p.id}>
                            {i > 0 && ", "}
                            {p.name}
                            {(conflicts.get(p.id) ?? []).length > 0 && (
                              <Badge
                                tone="warning"
                                className="ml-1"
                                title={(conflicts.get(p.id) ?? []).join(", ")}
                              >
                                Also in {(conflicts.get(p.id) ?? []).join(", ")}
                              </Badge>
                            )}
                          </span>
                        ))
                      )}
                    </div>

                    {/* Volunteers */}
                    {volunteers.length > 0 && (
                      <div className="mb-2">
                        <p className="mb-1 text-sm font-medium text-slate-600">Volunteers</p>
                        <div className="flex flex-col gap-1">
                          {volunteers.map((v) => (
                            <div key={v.id} className="flex flex-wrap items-center gap-2 text-sm">
                              <span>{v.name}</span>
                              {v.tags.triage && <Badge tone="default">Triage</Badge>}
                              {v.tags.walkin && <Badge tone="default">Walk-in</Badge>}
                              {v.tags.cc && <Badge tone="default">CC</Badge>}
                              {v.tags.remote && <Badge tone="default">Remote</Badge>}
                              {(conflicts.get(v.id) ?? []).length > 0 && (
                                <Badge
                                  tone="warning"
                                  title={(conflicts.get(v.id) ?? []).join(", ")}
                                >
                                  Also in {(conflicts.get(v.id) ?? []).join(", ")}
                                </Badge>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Shadows */}
                    <div className="text-sm">
                      <span className="font-medium text-slate-600">Shadows: </span>
                      {shadows.length === 0 ? (
                        <span className="text-slate-400">None</span>
                      ) : (
                        shadows.map((p, i) => (
                          <span key={p.id}>
                            {i > 0 && ", "}
                            {p.name}
                            {(conflicts.get(p.id) ?? []).length > 0 && (
                              <Badge
                                tone="warning"
                                className="ml-1"
                                title={(conflicts.get(p.id) ?? []).join(", ")}
                              >
                                Also in {(conflicts.get(p.id) ?? []).join(", ")}
                              </Badge>
                            )}
                          </span>
                        ))
                      )}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
