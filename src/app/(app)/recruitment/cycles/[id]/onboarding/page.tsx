import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import { getCycle } from "@/modules/recruitment/services/cycles";
import { listOnboarding } from "@/modules/recruitment/services/onboarding";
import { parseContractLayout } from "@/modules/recruitment/contract/layout";
import { sendLinksAction, promoteAction, withdrawContractAction } from "./actions";
import { SetBreadcrumb } from "@/platform/ui/breadcrumb-context";
import { cycleTrail } from "@/modules/recruitment/breadcrumbs";
import { PageHeader } from "@/platform/ui/page-header";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { Badge } from "@/platform/ui/badge";
import { Checkbox } from "@/platform/ui/checkbox";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { SubmitButton } from "@/platform/ui/submit-button";
import { SectionHeader } from "@/platform/ui/section-header";

type Tone = "default" | "brand" | "success" | "warning";

function statusLabel(c: { status: string } | null): { label: string; tone: Tone } {
  if (!c) return { label: "No contract", tone: "default" };
  if (c.status === "PENDING") return { label: "Sent", tone: "brand" };
  if (c.status === "SUBMITTED") return { label: "Submitted", tone: "warning" };
  return { label: "Promoted", tone: "success" };
}

export default async function OnboardingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requirePermission("recruitment.access");
  await requirePermission("recruitment.review_all");
  const cycle = await getCycle(id);
  if (!cycle) notFound();
  const rows = await listOnboarding(id);
  // Conflicted acceptances (applicant accepted by >1 department) cannot be
  // onboarded or promoted until SRR resolves the conflict on the Decisions page.
  const promotable = rows.filter((r) => r.contract?.status === "SUBMITTED" && !r.conflicted);
  const hasConflicts = rows.some((r) => r.conflicted);

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

      <form action={sendLinksAction.bind(null, id)} className="space-y-3">
        <Table>
          <THead>
            <tr>
              <TH className="w-10"><span className="sr-only">Select</span></TH>
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
                  <TD>{!r.conflicted && r.contract?.status !== "SUBMITTED" && r.contract?.status !== "PROMOTED" && <Checkbox name="acceptanceId" value={r.id} aria-label={`Select ${r.application.applicant.firstName} ${r.application.applicant.lastName}`} />}</TD>
                  <TD className="font-medium text-foreground">
                    {r.application.applicant.firstName} {r.application.applicant.lastName}
                    {(() => {
                      // Surface any per-cycle custom onboarding answers so they are
                      // readable here instead of being collected and never seen.
                      // Resolve the human label for each REAL custom question in the
                      // contract snapshot, then show ONLY those answers. customAnswers
                      // also holds internal confirm__<agreementId> checkbox-agreement keys
                      // (submitContract stores them there) and can carry a stale answer to a
                      // question this contract never showed; keying off the snapshot's
                      // custom_question blocks drops both, so reviewers see "T-shirt size",
                      // not junk rows like "confirm__strike_policy: on" (#88).
                      const labels: Record<string, string> = {};
                      try {
                        if (r.contract?.templateSnapshot) {
                          for (const b of parseContractLayout(r.contract.templateSnapshot).blocks) {
                            if (b.kind === "custom_question") labels[b.key] = b.label;
                          }
                        }
                      } catch {
                        /* invalid snapshot -> show no custom answers */
                      }
                      const ca = (r.contract?.customAnswers ?? {}) as Record<string, unknown>;
                      const entries = Object.entries(ca).filter(([k, v]) => k in labels && v != null && v !== "");
                      if (entries.length === 0) return null;
                      return (
                        <dl className="mt-1 space-y-0.5 text-xs font-normal text-subtle-foreground">
                          {entries.map(([k, v]) => (
                            <div key={k}>
                              <span className="font-medium">{labels[k] ?? k}:</span> {Array.isArray(v) ? v.join(", ") : String(v)}
                            </div>
                          ))}
                        </dl>
                      );
                    })()}
                  </TD>
                  <TD className="text-foreground-soft">{r.departmentCode}</TD>
                  <TD>
                    {r.conflicted ? (
                      <Badge tone="warning">Conflict</Badge>
                    ) : (
                      <>
                        <Badge tone={s.tone}>{s.label}</Badge>
                        {r.contract?.promotedPersonId && <span className="ml-2 text-xs text-subtle-foreground">on roster</span>}
                        {(r.contract?.status === "SUBMITTED" || r.contract?.status === "PROMOTED") && (
                          <Link className="ml-2 text-xs text-brand-fg hover:text-brand-hover" href={`/recruitment/cycles/${id}/onboarding/${r.contract.id}`}>
                            View
                          </Link>
                        )}
                        {/* Withdraw a not-yet-promoted contract so its acceptance can
                            be rescinded or re-decided (the Decisions page refuses to
                            touch an acceptance while a contract exists). PROMOTED is
                            excluded: that person is on the roster, so the reversal is
                            offboarding, not a withdraw. formAction submits this one
                            row's contractId to the withdraw action within the
                            surrounding send-links form (no nested form). */}
                        {r.contract && r.contract.status !== "PROMOTED" && (
                          <ConfirmButton
                            label="Withdraw"
                            size="sm"
                            className="ml-2 inline-flex align-middle"
                            formAction={withdrawContractAction.bind(null, id)}
                            name="contractId"
                            value={r.contract.id}
                            confirmLabel={`Withdraw${r.contract.status === "SUBMITTED" ? " (deletes the submitted contract + signatures)" : ""}?`}
                          />
                        )}
                      </>
                    )}
                  </TD>
                </TR>
              );
            })}
            {rows.length === 0 && (
              <TR>
                <TD colSpan={4} className="py-10 text-center text-subtle-foreground">
                  No accepted applicants yet.
                </TD>
              </TR>
            )}
          </tbody>
        </Table>
        <SubmitButton size="sm" pendingLabel="Sending…">
          Send / resend onboarding links
        </SubmitButton>
        <p className="text-xs text-subtle-foreground">
          Resending refreshes the 21-day expiry on the same link, so an expired or
          undelivered link is recoverable without a fresh acceptance.
        </p>
        {hasConflicts && (
          <p className="text-xs text-subtle-foreground">
            Applicants accepted by more than one department are marked{" "}
            <span className="font-medium text-foreground-soft">Conflict</span> and can&apos;t be onboarded until you resolve
            them on the{" "}
            <Link className="text-brand-fg hover:text-brand-hover" href={`/recruitment/cycles/${id}/decisions`}>
              Decisions
            </Link>{" "}
            page.
          </p>
        )}
      </form>

      <form action={promoteAction.bind(null, id)} className="space-y-3 border-t border-border pt-6">
        <SectionHeader>Promote submitted contracts</SectionHeader>
        {promotable.length === 0 ? (
          <p className="text-sm text-muted-foreground">No submitted contracts ready to promote.</p>
        ) : (
          <ul className="space-y-2">
            {promotable.map((r) => (
              <li key={r.id}>
                <label className="flex items-center gap-2 text-sm text-foreground-soft">
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
