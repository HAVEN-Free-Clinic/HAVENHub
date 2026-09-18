import { notFound } from "next/navigation";
import { PageBody } from "@/platform/ui/page-body";
import { requirePermission } from "@/platform/auth/session";
import { getCycle } from "@/modules/recruitment/services/cycles";
import { listConflicts, releaseSummary, rejectionSummary } from "@/modules/recruitment/services/decisions";
import { assessmentHoldSummary } from "@/modules/recruitment/services/assessment-holds";
import { waitlistEmailSummary } from "@/modules/recruitment/services/waitlist-emails";
import {
  releaseDecisionsAction,
  sendRejectionsAction,
  sendWaitlistEmailsAction,
  sendAssessmentHoldsAction,
  keepBothDepartmentsAction,
} from "./actions";
import { SubmitButton } from "@/platform/ui/submit-button";
import { SetBreadcrumb } from "@/platform/ui/breadcrumb-context";
import { cycleTrail } from "@/modules/recruitment/breadcrumbs";
import { PageHeader } from "@/platform/ui/page-header";
import { StatCard } from "@/platform/ui/stat-card";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { cardClasses } from "@/platform/ui/card";
import { SectionHeader } from "@/platform/ui/section-header";
import { EmptyState } from "@/platform/ui/empty-state";
import { TextLink } from "@/platform/ui/text-link";

/** Reads the one query param the actions redirect back with. Both actions can
 *  land here with an ?error= (a permission or ordering refusal), and until this
 *  page read it those refusals were silently swallowed: the user pressed
 *  Release, nothing happened, and nothing said why. */

export default async function DecisionsPage({ params }: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requirePermission("recruitment.access");
  await requirePermission("recruitment.review_all");
  const cycle = await getCycle(id);
  if (!cycle) notFound();
  const [conflicts, summary, rejections, waitlist, holds] = await Promise.all([
    listConflicts(id),
    releaseSummary(id),
    rejectionSummary(id),
    waitlistEmailSummary(id),
    assessmentHoldSummary(id),
  ]);

  // wide, not form: this holds a four-up StatCard grid over a conflicts list,
  // which 42rem was cramping. Not `full` either -- four stat cards stretched
  // across 72rem read as four thin bars, and the list below is prose-width.
  return (
    <PageBody width="wide">
      <SetBreadcrumb
        trail={cycleTrail({
          cycleId: id,
          cycleTitle: cycle.title,
          section: { label: "Decisions", slug: "decisions" },
        })}
      />
      <PageHeader title="Decisions" description={cycle.title} />

      {/* No inline Alert: FlashReader claims this param, toasts it, and strips it
          from the URL, so an inline branch reported it twice and then lost its
          value on the router.replace. Error toasts do not auto-dismiss. */}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Accepted" value={summary.acceptedApplications} />
        <StatCard label="Unnotified" value={summary.unnotified} />
        <StatCard label="Conflicts" value={summary.conflictedApplications} tone={summary.conflictedApplications > 0 ? "critical" : "default"} />
        <StatCard label="Emailed" value={summary.emailed} />
      </div>

      <p className="text-sm text-foreground-soft">
        {summary.dualAppointments === 0
          ? "No dual appointments."
          : `${summary.dualAppointments} accepted ${summary.dualAppointments === 1 ? "applicant is" : "applicants are"} a dual appointment, accepted into two departments.`}{" "}
        <TextLink href={`/recruitment/cycles/${id}/dual-appointments`}>Dual appointments</TextLink>
      </p>

      <section>
        <SectionHeader>Conflicts to resolve</SectionHeader>
        {conflicts.length === 0 ? (
          <EmptyState inline className="mt-2">No conflicts.</EmptyState>
        ) : (
          <ul className={`mt-3 divide-y divide-border-subtle ${cardClasses({ pad: false })}`}>
            {conflicts.map((c) => (
              <li key={c.applicationId} className="px-4 py-2.5 text-sm text-foreground-soft">
                <TextLink
                  className="font-medium"
                  href={`/recruitment/cycles/${id}/applicants/${c.applicationId}`}
                >
                  {c.applicantName}
                </TextLink>{" "}
                accepted by {c.departments.join(" + ")}
                {/* The other way to resolve a conflict: keep both, when a strong
                    volunteer really should serve in two departments. Revoking one
                    is still on the applicant page. */}
                {c.canBecomeDualAppointment && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {c.departments
                      .filter((d) => d !== c.routedDepartmentCode)
                      .map((d) => (
                        <form key={d} action={keepBothDepartmentsAction.bind(null, id)}>
                          <input type="hidden" name="applicationId" value={c.applicationId} />
                          <input type="hidden" name="departmentCode" value={d} />
                          <SubmitButton size="sm" variant="outline" pendingLabel="Saving…">
                            Keep both ({d} as dual appointment)
                          </SubmitButton>
                        </form>
                      ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <form action={releaseDecisionsAction.bind(null, id)} className="space-y-2">
        <ConfirmButton label="Release decisions" confirmLabel="Send acceptance emails?" />
        <p className="text-xs text-subtle-foreground">
          Emails every accepted, non-conflicted applicant who hasn&apos;t been notified yet. A dual appointment gets one
          email naming both departments.
        </p>
      </form>

      {/* Rejections are their own section and their own button, not part of
          Release. SRR times and checks this send separately -- see the block
          comment in services/decisions.ts. */}
      <section className="space-y-3 border-t border-border-subtle pt-6">
        <SectionHeader>Not selected</SectionHeader>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <StatCard label="Not selected" value={rejections.rejected} />
          <StatCard label="Unnotified" value={rejections.unnotified} />
          <StatCard label="Emailed" value={rejections.emailed} />
        </div>

        <form action={sendRejectionsAction.bind(null, id)} className="space-y-2">
          <ConfirmButton
            label="Send rejection emails"
            confirmLabel={`Email ${rejections.unnotified} not-selected ${rejections.unnotified === 1 ? "applicant" : "applicants"}?`}
            disabled={!rejections.released || rejections.unnotified === 0}
          />
          <p className="text-xs text-subtle-foreground">
            {!rejections.released
              ? "Release decisions first, so accepted applicants hear before anyone is told they were not selected."
              : rejections.unnotified === 0
                ? "Everyone marked Rejected on the applicant roster has already been emailed."
                : "Emails every applicant the roster shows as Rejected and who hasn't been notified yet. Applicants who were accepted, waitlisted, still undecided, or who withdrew are never included."}
          </p>
        </form>
      </section>

      {/* The capacity waitlist. Never the interpreting department's, and never
          anyone still awaiting a language evaluation: both of those are told to
          come to training by the section below, and this email says not to. */}
      <section className="space-y-3 border-t border-border-subtle pt-6">
        <SectionHeader>Waitlisted</SectionHeader>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <StatCard label="Waitlisted" value={waitlist.waitlisted} />
          <StatCard label="Unnotified" value={waitlist.unnotified} />
          <StatCard label="Emailed" value={waitlist.emailed} />
        </div>

        <form action={sendWaitlistEmailsAction.bind(null, id)} className="space-y-2">
          <ConfirmButton
            label="Send waitlist emails"
            confirmLabel={`Email ${waitlist.unnotified} waitlisted ${waitlist.unnotified === 1 ? "applicant" : "applicants"}?`}
            disabled={!waitlist.released || waitlist.unnotified === 0}
          />
          <p className="text-xs text-subtle-foreground">
            {!waitlist.released
              ? "Release decisions first, so accepted applicants hear before anyone is told they are waiting."
              : waitlist.unnotified === 0
                ? "Everyone on the waitlist this email is for has already been emailed."
                : "Emails every waitlisted applicant who hasn't been notified yet, telling them they are still in consideration and do not need to come to training. Interpreting's waitlist and anyone still awaiting a language evaluation are left out. A waitlisted applicant never gets a rejection email unless they are later marked Rejected."}
          </p>
        </form>
      </section>

      {/* Its own section for the same reason rejections have one: this send is
          timed and checked separately, and it goes to people who are getting no
          decision at all today. Hidden entirely on a cycle with nobody on hold,
          which is every cycle outside the departments that assess language
          before accepting. */}
      {holds.onHold > 0 && (
        <section className="space-y-3 border-t border-border-subtle pt-6">
          <SectionHeader>Waiting on a language evaluation</SectionHeader>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <StatCard label="On hold" value={holds.onHold} />
            <StatCard label="Unnotified" value={holds.unnotified} />
            <StatCard label="Emailed" value={holds.emailed} />
          </div>

          <form action={sendAssessmentHoldsAction.bind(null, id)} className="space-y-2">
            <ConfirmButton
              label="Send evaluation-pending emails"
              confirmLabel={`Email ${holds.unnotified} waiting ${holds.unnotified === 1 ? "applicant" : "applicants"}?`}
              disabled={holds.unnotified === 0}
            />
            <p className="text-xs text-subtle-foreground">
              {holds.unnotified === 0
                ? "Everyone waitlisted and still awaiting a language evaluation has already been emailed."
                : "Emails every applicant who is waitlisted and still awaiting a language evaluation, telling them this is not a rejection, asking which dialect they speak, and confirming they are still expected at training. Does not wait for Release: it lands instead of a decision."}
            </p>
          </form>
        </section>
      )}
    </PageBody>
  );
}
