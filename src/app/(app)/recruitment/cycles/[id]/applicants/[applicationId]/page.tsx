import Link from "next/link";
import { notFound } from "next/navigation";
import { getApplication } from "@/modules/recruitment/services/submissions";
import { visibleSections, applicantTypeLabel } from "@/modules/recruitment/engine/visibility";
import { requirePersonSession } from "@/platform/auth/session";
import { reviewScope, listAcceptances } from "@/modules/recruitment/services/review";
import { can } from "@/platform/rbac/engine";
import { acceptApplicantAction, revokeAcceptanceAction, scheduleInterviewAction } from "../actions";
import { listApplicationInterviews } from "@/modules/recruitment/services/interviews";
import { SetBreadcrumb } from "@/platform/ui/breadcrumb-context";
import { cycleTrail } from "@/modules/recruitment/breadcrumbs";
import { PageHeader } from "@/platform/ui/page-header";
import { Field, Input } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { Alert } from "@/platform/ui/alert";
import { Badge } from "@/platform/ui/badge";
import { SubmitButton } from "@/platform/ui/submit-button";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { Card } from "@/platform/ui/card";
import { prisma } from "@/platform/db";

export default async function ApplicationDetailPage({ params, searchParams }: { params: Promise<{ id: string; applicationId: string }>; searchParams: Promise<{ error?: string }> }) {
  const { id, applicationId } = await params;
  const { error } = await searchParams;
  const app = await getApplication(applicationId);
  if (!app) notFound();
  const person = await requirePersonSession();
  if (app.cycleId !== id) notFound();
  const [scope, managesCycles, acceptances] = await Promise.all([
    reviewScope(person.personId),
    can(person.personId, "recruitment.manage_cycles"),
    listAcceptances(applicationId),
  ]);
  const seeAll = scope.all || managesCycles;
  const canView = seeAll || app.departmentChoices.some((d) => scope.departmentCodes.includes(d));
  if (!canView) notFound();
  const eligible = seeAll
    ? app.cycle.departments
    : app.cycle.departments.filter((d) => scope.departmentCodes.includes(d) && app.departmentChoices.includes(d));
  const accepted = new Set(acceptances.map((a) => a.departmentCode));
  const choices = eligible.filter((d) => !accepted.has(d));
  const rankIds = [...new Set([...app.subcommitteeRanking, app.assignedSubcommitteeId].filter((x): x is string => Boolean(x)))];
  const subRows = rankIds.length
    ? await prisma.subcommittee.findMany({ where: { id: { in: rankIds } }, select: { id: true, name: true } })
    : [];
  const subName = new Map(subRows.map((s) => [s.id, s.name]));
  const existingInterviews = app.cycle.track === "DIRECTOR" ? await listApplicationInterviews(applicationId) : [];
  const interviewedDepts = new Set(existingInterviews.map((i) => i.departmentCode));
  const scheduleChoices = choices.filter((d) => !interviewedDepts.has(d));
  const answers = (app.answers ?? {}) as Record<string, unknown>;
  const sections = visibleSections(app.cycle.sections, {
    applicantType: app.applicantType,
    selectedDepartmentCodes: app.departmentChoices,
  });
  return (
    <div className="max-w-2xl space-y-6">
      <SetBreadcrumb
        trail={cycleTrail({
          cycleId: id,
          cycleTitle: app.cycle.title,
          section: { label: "Applicants", slug: "applicants" },
          leaf: `${app.applicant.firstName} ${app.applicant.lastName}`,
        })}
      />
      <PageHeader
        title={`${app.applicant.firstName} ${app.applicant.lastName}`}
        description={`${app.applicant.email} · ${applicantTypeLabel(app.applicantType)}${
          app.renewalDepartment ? ` · renewing in ${app.renewalDepartment}` : ""
        }${
          app.applicantType === "TRANSFER" && app.transferFromDepartments.length > 0
            ? ` · returning member, previously ${app.transferFromDepartments.join(", ")}`
            : ""
        }`}
      />

      {sections.map((section) => (
        <Card key={section.id}>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">{section.title}</h2>
          <dl className="mt-3 grid gap-3 sm:grid-cols-2">
            {section.fields.map((f) => {
              const val = answers[f.key];
              const display = f.type === "FILE" && val && typeof val === "object"
                ? (val as { fileName?: string }).fileName ?? "(file)"
                : Array.isArray(val) ? val.join(", ") : val === undefined || val === "" ? "(none)" : String(val);
              return (
                <div key={f.id}>
                  <dt className="text-xs text-subtle-foreground">{f.label}</dt>
                  <dd className="mt-0.5 text-sm text-foreground">{display}</dd>
                </div>
              );
            })}
          </dl>
        </Card>
      ))}

      {(app.subcommitteeRanking.length > 0 || app.assignedSubcommitteeId) && (
        <Card>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Subcommittee</h2>
          <dl className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <dt className="text-xs text-subtle-foreground">Ranked preferences</dt>
              <dd className="mt-0.5 text-sm text-foreground">
                {app.subcommitteeRanking.length === 0
                  ? "(none)"
                  : app.subcommitteeRanking.map((sid, i) => `${i + 1}. ${subName.get(sid) ?? "(removed)"}`).join("  ·  ")}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-subtle-foreground">Assigned</dt>
              <dd className="mt-0.5 text-sm text-foreground">
                {app.assignedSubcommitteeId ? (subName.get(app.assignedSubcommitteeId) ?? "(removed)") : "Not assigned"}
              </dd>
            </div>
          </dl>
          <p className="mt-2 text-xs text-subtle-foreground">Assign from the cycle&apos;s Subcommittees view.</p>
        </Card>
      )}

      {app.cycle.track === "VOLUNTEER" ? (
        <Card>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Decision</h2>
          {error && <Alert tone="error" className="mt-3">{error}</Alert>}
          {acceptances.length > 0 ? (
            <ul className="mt-3 divide-y divide-border-subtle">
              {acceptances.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-4 py-2 text-sm">
                  <span className="text-foreground-soft">
                    Accepted into <strong className="text-foreground">{a.departmentCode}</strong>
                    {a.notes ? `: ${a.notes}` : ""}
                    {a.emailedAt && <Badge tone="success" className="ml-2">notified</Badge>}
                  </span>
                  <form action={revokeAcceptanceAction.bind(null, id, applicationId, a.id)}>
                    <ConfirmButton label="Revoke" size="sm" />
                  </form>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">No acceptances yet.</p>
          )}
          {choices.length > 0 && (
            <form
              action={acceptApplicantAction.bind(null, id, applicationId)}
              className="mt-4 flex flex-wrap items-end gap-3 border-t border-border-subtle pt-4"
            >
              <div className="w-40">
                <Field label="Department">
                  <Select name="departmentCode" required>
                    {choices.map((d) => (
                      <option key={d} value={d}>{d}</option>
                    ))}
                  </Select>
                </Field>
              </div>
              <div className="min-w-[12rem] flex-1">
                <Field label="Notes" hint="Optional.">
                  <Input name="notes" />
                </Field>
              </div>
              <SubmitButton size="sm" pendingLabel="Accepting…">Accept</SubmitButton>
            </form>
          )}
        </Card>
      ) : (
        <Card>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Interview</h2>
          {error && <Alert tone="error" className="mt-3">{error}</Alert>}
          {existingInterviews.length > 0 && (
            <ul className="mt-3 space-y-1 text-sm">
              {existingInterviews.map((iv) => (
                <li key={iv.id}>
                  <Link
                    className="font-medium text-brand-fg hover:text-brand-hover"
                    href={`/recruitment/interviews/${iv.id}`}
                  >
                    Interview for {iv.departmentCode}
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {scheduleChoices.length > 0 ? (
            <form
              action={scheduleInterviewAction.bind(null, id, applicationId)}
              className="mt-4 flex flex-wrap items-end gap-3 border-t border-border-subtle pt-4"
            >
              <div className="w-40">
                <Field label="Department">
                  <Select name="departmentCode" required>
                    {scheduleChoices.map((d) => (
                      <option key={d} value={d}>{d}</option>
                    ))}
                  </Select>
                </Field>
              </div>
              <SubmitButton size="sm" pendingLabel="Scheduling…">Schedule interview</SubmitButton>
            </form>
          ) : existingInterviews.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">No eligible department to interview for in your scope.</p>
          ) : null}
        </Card>
      )}
    </div>
  );
}
