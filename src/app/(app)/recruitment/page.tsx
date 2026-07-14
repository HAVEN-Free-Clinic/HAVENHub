import Link from "next/link";
import { can } from "@/platform/rbac/engine";
import { listCycles, listArchivedCycles } from "@/modules/recruitment/services/cycles";
import { listReviewableCycles } from "@/modules/recruitment/services/review";
import { requireRecruitmentStaff } from "./cycles/access";
import { PageHeader } from "@/platform/ui/page-header";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { Badge } from "@/platform/ui/badge";
import { buttonClasses } from "@/platform/ui/button";

const statusTone = {
  DRAFT: "default",
  OPEN: "success",
  CLOSED: "warning",
  ARCHIVED: "default",
} as const;

const trackLabels: Record<string, string> = { VOLUNTEER: "Volunteer", DIRECTOR: "Director" };
function trackLabel(track: string): string {
  return trackLabels[track] ?? track.charAt(0) + track.slice(1).toLowerCase();
}

export default async function RecruitmentPage() {
  // Admits anyone with any recruitment capability (module access, committee
  // scoring, or a review scope), not just recruitment.access -- see
  // requireRecruitmentStaff. hasAccess below narrows the data source and links.
  const session = await requireRecruitmentStaff();
  // Only cycle managers can actually create a cycle (createCycleAction enforces
  // recruitment.manage_cycles), so hide the affordance from reviewers who hold
  // recruitment.access but not manage_cycles -- they'd hit /no-access otherwise.
  const [canManageCycles, hasAccess] = await Promise.all([
    can(session.personId, "recruitment.manage_cycles"),
    can(session.personId, "recruitment.access"),
  ]);
  // Full module access sees every cycle, linking to the cycle overview. Reviewers
  // without module access (committee scorers, scope-only directors) see only the
  // cycles they have something to review in, linking straight to the roster.
  const [cycles, archivedCycles] = hasAccess
    ? await Promise.all([listCycles(), listArchivedCycles()])
    : [await listReviewableCycles(session.personId), []];
  const cycleHref = (id: string) => (hasAccess ? `/recruitment/cycles/${id}` : `/recruitment/cycles/${id}/applicants`);
  return (
    <div className="space-y-6">
      <PageHeader
        title="Recruitment cycles"
        description="Application cycles for volunteers and directors."
        action={
          canManageCycles ? (
            <Link href="/recruitment/cycles/new" className={buttonClasses("primary", "sm")}>
              New cycle
            </Link>
          ) : undefined
        }
      />
      <Table>
        <THead>
          <tr>
            <TH>Title</TH>
            <TH>Track</TH>
            <TH>Status</TH>
          </tr>
        </THead>
        <tbody>
          {cycles.map((c) => (
            <TR key={c.id}>
              <TD>
                <Link href={cycleHref(c.id)} className="font-medium text-foreground hover:text-brand-fg">
                  {c.title}
                </Link>
              </TD>
              <TD className="text-foreground-soft">{trackLabel(c.track)}</TD>
              <TD>
                <Badge tone={statusTone[c.status as keyof typeof statusTone] ?? "default"}>{c.status}</Badge>
              </TD>
            </TR>
          ))}
          {cycles.length === 0 && (
            <TR>
              <TD colSpan={3} className="py-10 text-center text-subtle-foreground">
                {hasAccess
                  ? archivedCycles.length > 0
                    ? "No active cycles."
                    : "No cycles yet. Create one to get started."
                  : "No cycles to review right now."}
              </TD>
            </TR>
          )}
        </tbody>
      </Table>

      {archivedCycles.length > 0 && (
        <details>
          <summary className="cursor-pointer select-none text-sm font-medium text-foreground hover:text-brand-fg">
            Archived ({archivedCycles.length})
          </summary>
          <div className="mt-3">
            <Table>
              <THead>
                <tr>
                  <TH>Title</TH>
                  <TH>Track</TH>
                  <TH>Status</TH>
                </tr>
              </THead>
              <tbody>
                {archivedCycles.map((c) => (
                  <TR key={c.id}>
                    <TD>
                      <Link href={cycleHref(c.id)} className="font-medium text-foreground hover:text-brand-fg">
                        {c.title}
                      </Link>
                    </TD>
                    <TD className="text-foreground-soft">{trackLabel(c.track)}</TD>
                    <TD>
                      <Badge tone={statusTone[c.status as keyof typeof statusTone] ?? "default"}>{c.status}</Badge>
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          </div>
        </details>
      )}
    </div>
  );
}
