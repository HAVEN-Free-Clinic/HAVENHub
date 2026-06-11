import { notFound } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import { getCycle } from "@/modules/recruitment/services/cycles";
import { listOnboarding } from "@/modules/recruitment/services/onboarding";
import { sendLinksAction, promoteAction } from "./actions";
import { SetBreadcrumb } from "@/platform/ui/breadcrumb-context";
import { cycleTrail } from "@/modules/recruitment/breadcrumbs";
import { PageHeader } from "@/platform/ui/page-header";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { Badge } from "@/platform/ui/badge";
import { Checkbox } from "@/platform/ui/checkbox";
import { Alert } from "@/platform/ui/alert";
import { SubmitButton } from "@/platform/ui/submit-button";

type Tone = "default" | "brand" | "success" | "warning";

function statusLabel(c: { status: string } | null): { label: string; tone: Tone } {
  if (!c) return { label: "No contract", tone: "default" };
  if (c.status === "PENDING") return { label: "Sent", tone: "brand" };
  if (c.status === "SUBMITTED") return { label: "Submitted", tone: "warning" };
  return { label: "Promoted", tone: "success" };
}

export default async function OnboardingPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string; err?: string }> }) {
  const { id } = await params;
  const { msg, err } = await searchParams;
  await requirePermission("recruitment.review_all");
  const cycle = await getCycle(id);
  if (!cycle) notFound();
  const rows = await listOnboarding(id);
  const promotable = rows.filter((r) => r.contract?.status === "SUBMITTED");

  return (
    <div className="max-w-3xl space-y-6">
      <SetBreadcrumb
        trail={cycleTrail({
          cycleId: id,
          cycleTitle: cycle.title,
          section: { label: "Onboarding", slug: "onboarding" },
        })}
      />
      <PageHeader title="Onboarding" description={cycle.title} />
      {err && <Alert tone="error">{err}</Alert>}
      {msg && <Alert tone="success">{msg}</Alert>}

      <form action={sendLinksAction.bind(null, id)} className="space-y-3">
        <Table>
          <THead>
            <tr>
              <TH className="w-10"></TH>
              <TH>Applicant</TH>
              <TH>Dept</TH>
              <TH>Status</TH>
            </tr>
          </THead>
          <tbody>
            {rows.map((r) => {
              const s = statusLabel(r.contract);
              return (
                <TR key={r.id}>
                  <TD>{!r.contract && <Checkbox name="acceptanceId" value={r.id} />}</TD>
                  <TD className="font-medium text-slate-900">
                    {r.application.applicant.firstName} {r.application.applicant.lastName}
                  </TD>
                  <TD className="text-slate-600">{r.departmentCode}</TD>
                  <TD>
                    <Badge tone={s.tone}>{s.label}</Badge>
                    {r.contract?.promotedPersonId && <span className="ml-2 text-xs text-slate-400">on roster</span>}
                  </TD>
                </TR>
              );
            })}
            {rows.length === 0 && (
              <TR>
                <TD colSpan={4} className="py-10 text-center text-slate-400">
                  No accepted applicants yet.
                </TD>
              </TR>
            )}
          </tbody>
        </Table>
        <SubmitButton size="sm" pendingLabel="Sending…">
          Send onboarding links
        </SubmitButton>
      </form>

      <form action={promoteAction.bind(null, id)} className="space-y-3 border-t border-slate-200 pt-6">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-500">Promote submitted contracts</h2>
        {promotable.length === 0 ? (
          <p className="text-sm text-slate-500">No submitted contracts ready to promote.</p>
        ) : (
          <ul className="space-y-2">
            {promotable.map((r) => (
              <li key={r.id}>
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <Checkbox name="contractId" value={r.contract!.id} />
                  {r.application.applicant.firstName} {r.application.applicant.lastName} ({r.departmentCode})
                </label>
              </li>
            ))}
          </ul>
        )}
        <SubmitButton size="sm" pendingLabel="Promoting…" disabled={promotable.length === 0}>
          Promote selected
        </SubmitButton>
      </form>
    </div>
  );
}
