import { requireModuleAccess } from "@/platform/auth/session";
import { Badge } from "@/platform/ui/badge";
import { cardClasses } from "@/platform/ui/card";
import { PageHeader } from "@/platform/ui/page-header";
import { SectionHeader } from "@/platform/ui/section-header";
import { fullSchedule } from "@/modules/schedule/services/schedule";
import { isoDateKey } from "@/modules/schedule/engine/map";
import { ClinicDateStrip } from "@/modules/schedule/components/clinic-date-strip";
import { formatCalendarDate } from "@/platform/dates";

type PageProps = {
  searchParams: Promise<{ date?: string; [key: string]: string | string[] | undefined }>;
};

export default async function FullSchedulePage({ searchParams }: PageProps) {
  await requireModuleAccess("schedule");
  const sp = await searchParams;

  const { term, clinicDates, selectedDate, departments } = await fullSchedule(sp.date);
  const selectedKey = selectedDate ? isoDateKey(selectedDate) : null;

  const selectedDisplay = selectedDate
    ? formatCalendarDate(selectedDate, { weekday: "long", month: "long", day: "numeric", year: "numeric" })
    : null;

  const totalVolunteers = departments.reduce((acc, d) => acc + d.volunteers.length, 0);
  const totalDirectors = departments.reduce((acc, d) => acc + d.directors.length, 0);
  const totalShadows = departments.reduce((acc, d) => acc + d.shadows.length, 0);

  return (
    <div>
      <div className="mb-8">
        <PageHeader
          title="Full Schedule"
          description={
            term
              ? `${term.name}${
                  selectedDate && departments.length > 0
                    ? ` · ${totalDirectors} director${totalDirectors !== 1 ? "s" : ""}, ${totalVolunteers} volunteer${
                        totalVolunteers !== 1 ? "s" : ""
                      }, ${totalShadows} shadow${totalShadows !== 1 ? "s" : ""} across ${departments.length} department${
                        departments.length !== 1 ? "s" : ""
                      }`
                    : ""
                }`
              : undefined
          }
        />
      </div>

      {!term ? (
        <p className="text-sm text-subtle-foreground">No active term.</p>
      ) : (
        <>
          {/* Date strip */}
          <div className="mb-8">
            <ClinicDateStrip
              dates={clinicDates}
              selectedKey={selectedKey}
              hrefFor={(key) => `/schedule/full?date=${key}`}
              ariaLabel="Schedule dates"
            />
          </div>

          {selectedDisplay && <SectionHeader level="title" className="mb-4">{selectedDisplay}</SectionHeader>}

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
                  {/* Card header. Neutral surface, not bg-brand: the brand colour means
                      "selected" everywhere else in this module, and a grid of brand-capped
                      cards spends it on decoration. */}
                  <div className="border-b border-border bg-muted px-4 py-3 flex flex-wrap items-center justify-between gap-2">
                    <SectionHeader as="h3" level="title" className="min-w-0 truncate">
                      {department.name}
                    </SectionHeader>
                    <div className="flex items-center gap-1.5">
                      <Badge>{department.code}</Badge>
                      {directors.length > 0 && <Badge tone="brand">{directors.length} director{directors.length === 1 ? "" : "s"}</Badge>}
                      {volunteers.length > 0 && <Badge tone="success">{volunteers.length} volunteer{volunteers.length === 1 ? "" : "s"}</Badge>}
                      {shadows.length > 0 && <Badge tone="warning">{shadows.length} shadow{shadows.length === 1 ? "" : "s"}</Badge>}
                    </div>
                  </div>

                  {/* Card body */}
                  <div className="px-4 py-4 flex flex-col gap-4">

                    {/* Directors */}
                    {directors.length > 0 && (
                      <div>
                        <SectionHeader as="h4" className="mb-1.5">Directors</SectionHeader>
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
                        <SectionHeader as="h4" className="mb-1.5">Volunteers</SectionHeader>
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
                        <SectionHeader as="h4" className="mb-1.5">Shadows</SectionHeader>
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