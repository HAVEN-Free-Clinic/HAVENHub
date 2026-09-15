import { notFound } from "next/navigation";
import type { DualAppointmentStatus } from "@prisma/client";
import { prisma } from "@/platform/db";
import { requirePersonSession } from "@/platform/auth/session";
import { reviewScope } from "@/modules/recruitment/services/review";
import {
  listDualAppointmentApplicantOptions,
  listDualAppointmentSuggestions,
  listDualAppointments,
  type DualAppointmentRow,
} from "@/modules/recruitment/services/dual-appointments";
import { cycleTrail } from "@/modules/recruitment/breadcrumbs";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import { formatDateOnly } from "@/platform/dates";
import { SetBreadcrumb } from "@/platform/ui/breadcrumb-context";
import { PageBody } from "@/platform/ui/page-body";
import { PageHeader } from "@/platform/ui/page-header";
import { SectionHeader } from "@/platform/ui/section-header";
import { Card } from "@/platform/ui/card";
import { Alert } from "@/platform/ui/alert";
import { EmptyState } from "@/platform/ui/empty-state";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { Badge, type Tone } from "@/platform/ui/badge";
import { SubmitButton } from "@/platform/ui/submit-button";
import { Field, Input, Textarea } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { Combobox } from "@/platform/ui/combobox";
import { FormActions } from "@/platform/ui/form";
import { TextLink } from "@/platform/ui/text-link";
import {
  approveDualAppointmentAction,
  cancelDualAppointmentAction,
  declineDualAppointmentAction,
  requestDualAppointmentAction,
} from "./actions";

/**
 * Dual appointments for one volunteer cycle: volunteers accepted into a second
 * department alongside the one their application routes to.
 *
 * Two audiences on one page. A department director asks for volunteers they
 * want (their own current volunteers who applied elsewhere are suggested) and
 * sees how those requests went. A recruitment manager decides the requests and
 * can add a dual appointment directly. Every rule lives in
 * services/dual-appointments.ts; this file only lays it out.
 */

const STATUS_LABEL: Record<DualAppointmentStatus, { label: string; tone: Tone }> = {
  PENDING: { label: "Waiting for approval", tone: "warning" },
  APPROVED: { label: "Approved", tone: "success" },
  DECLINED: { label: "Declined", tone: "default" },
  CANCELLED: { label: "Cancelled", tone: "default" },
};

const ONBOARDING_LABEL: Record<DualAppointmentRow["onboarding"], string> = {
  NOT_SENT: "Not sent yet",
  IN_PROGRESS: "In progress",
  ON_ROSTER: "On both rosters",
};

export default async function DualAppointmentsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requirePersonSession();
  const [cycle, scope] = await Promise.all([
    prisma.recruitmentCycle.findUnique({ where: { id }, select: { id: true, title: true, track: true, status: true } }),
    reviewScope(session.personId),
  ]);
  if (!cycle || cycle.track !== "VOLUNTEER") notFound();
  const isManager = scope.all;
  // The tab's own gate (cycle-nav.ts): a recruitment manager, or a director.
  if (!isManager && scope.departmentCodes.length === 0) notFound();

  const [rows, suggestions, applicantOptions, departments, zone] = await Promise.all([
    listDualAppointments({ cycleId: id }, session.personId),
    listDualAppointmentSuggestions(id, session.personId),
    isManager ? listDualAppointmentApplicantOptions(id, session.personId) : Promise.resolve([]),
    prisma.department.findMany({
      where: isManager ? { isActive: true } : { isActive: true, code: { in: scope.departmentCodes } },
      select: { code: true, name: true },
      orderBy: { name: "asc" },
    }),
    getDisplayTimeZone(),
  ]);
  const pending = rows.filter((r) => r.status === "PENDING");
  const approved = rows.filter((r) => r.status === "APPROVED");
  const closed = rows.filter((r) => r.status === "DECLINED" || r.status === "CANCELLED");
  const open = cycle.status === "OPEN" || cycle.status === "CLOSED";
  const nameOf = new Map(departments.map((d) => [d.code, d.name]));
  const date = (d: Date) => formatDateOnly(d, zone);

  const approve = approveDualAppointmentAction.bind(null, id);
  const decline = declineDualAppointmentAction.bind(null, id);
  const cancel = cancelDualAppointmentAction.bind(null, id);
  const request = requestDualAppointmentAction.bind(null, id);

  return (
    <PageBody width="wide">
      <SetBreadcrumb
        trail={cycleTrail({ cycleId: id, cycleTitle: cycle.title, section: { label: "Dual appointments", slug: "dual-appointments" } })}
      />
      <PageHeader
        title="Dual appointments"
        description={
          isManager
            ? "Volunteers accepted into a second department. Directors ask for a volunteer they want; you approve or decline. Approving accepts them into both departments: one acceptance email, one onboarding form, both rosters."
            : "Ask for a strong volunteer to serve in your department as well as the one they applied to. A recruitment manager approves each request."
        }
      />

      {!open && (
        <Alert tone="info">This cycle is {cycle.status.toLowerCase()}, so dual appointments cannot be requested or approved.</Alert>
      )}

      <section className="space-y-3">
        <SectionHeader>Waiting for approval</SectionHeader>
        {pending.length === 0 ? (
          <Card pad={false}>
            <EmptyState title="No requests are waiting." />
          </Card>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Volunteer</TH>
                <TH>Routed to</TH>
                <TH>Asking</TH>
                <TH>Why</TH>
                <TH>{isManager ? "Decision" : "Status"}</TH>
              </TR>
            </THead>
            <tbody>
              {pending.map((r) => (
                <TR key={r.id}>
                  <TD className="font-medium">
                    <VolunteerName row={r} cycleId={id} />
                    <span className="block text-xs text-subtle-foreground">
                      Requested by {r.requestedByName} on {date(r.requestedAt)}
                    </span>
                  </TD>
                  <TD className="text-foreground-soft">{r.routedDepartmentCode ?? "Not routed"}</TD>
                  <TD><Badge>{r.departmentCode}</Badge></TD>
                  <TD className="max-w-xs whitespace-pre-line text-foreground-soft">{r.reason ?? "-"}</TD>
                  <TD>
                    {r.canDecide && open ? (
                      <form action={approve} className="flex flex-wrap items-center gap-2">
                        <input type="hidden" name="id" value={r.id} />
                        <Input name="note" placeholder="Note (optional)" className="w-40" aria-label={`Note about ${r.applicantName}`} />
                        <SubmitButton size="sm" formAction={approve} pendingLabel="Approving…">Approve</SubmitButton>
                        <SubmitButton size="sm" variant="outline" formAction={decline} pendingLabel="Declining…">Decline</SubmitButton>
                      </form>
                    ) : r.canCancel ? (
                      <form action={cancel}>
                        <input type="hidden" name="id" value={r.id} />
                        <SubmitButton size="sm" variant="outline" pendingLabel="Withdrawing…">Withdraw request</SubmitButton>
                      </form>
                    ) : (
                      <Badge tone={STATUS_LABEL[r.status].tone}>{STATUS_LABEL[r.status].label}</Badge>
                    )}
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        )}
      </section>

      <section className="space-y-3">
        <SectionHeader>Approved</SectionHeader>
        {approved.length === 0 ? (
          <Card pad={false}>
            <EmptyState title="No dual appointments yet." />
          </Card>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Volunteer</TH>
                <TH>Departments</TH>
                <TH>Onboarding</TH>
                <TH>Approved</TH>
                {isManager && <TH><span className="sr-only">Actions</span></TH>}
              </TR>
            </THead>
            <tbody>
              {approved.map((r) => (
                <TR key={r.id}>
                  <TD className="font-medium">
                    <VolunteerName row={r} cycleId={id} />
                    {!r.applicationActive && <Badge className="ml-2">Withdrew</Badge>}
                  </TD>
                  <TD>
                    <div className="flex flex-wrap items-center gap-1">
                      {r.routedDepartmentCode && <Badge>{r.routedDepartmentCode}</Badge>}
                      <Badge tone="brand">{r.departmentCode}</Badge>
                    </div>
                  </TD>
                  <TD className="text-foreground-soft">{ONBOARDING_LABEL[r.onboarding]}</TD>
                  <TD className="text-foreground-soft">
                    {r.decidedByName ?? "-"}
                    {r.decidedAt && <span className="block text-xs text-subtle-foreground">{date(r.decidedAt)}</span>}
                  </TD>
                  {isManager && (
                    <TD>
                      {r.canCancel && (
                        <form action={cancel}>
                          <input type="hidden" name="id" value={r.id} />
                          <SubmitButton size="sm" variant="outline" pendingLabel="Cancelling…">Cancel</SubmitButton>
                        </form>
                      )}
                    </TD>
                  )}
                </TR>
              ))}
            </tbody>
          </Table>
        )}
      </section>

      {!isManager && suggestions.length > 0 && open && (
        <section className="space-y-3">
          <SectionHeader>Your volunteers who applied to another department</SectionHeader>
          <p className="text-sm text-muted-foreground">
            They serve with you now, and their application this cycle went elsewhere. Ask for the ones you want to keep.
          </p>
          <Table>
            <THead>
              <TR>
                <TH>Volunteer</TH>
                <TH>Serves with</TH>
                <TH>Applied to</TH>
                <TH>Request</TH>
              </TR>
            </THead>
            <tbody>
              {suggestions.map((s) => (
                <TR key={`${s.applicationId}:${s.departmentCode}`}>
                  <TD className="font-medium">{s.applicantName}</TD>
                  <TD><Badge>{s.departmentCode}</Badge></TD>
                  <TD className="text-foreground-soft">
                    {s.routedDepartmentCode ?? (s.departmentChoices.length > 0 ? `${s.departmentChoices.join(", ")} (not routed yet)` : "Not routed")}
                  </TD>
                  <TD>
                    <form action={request} className="flex flex-wrap items-center gap-2">
                      <input type="hidden" name="applicationId" value={s.applicationId} />
                      <input type="hidden" name="departmentCode" value={s.departmentCode} />
                      <Input name="reason" required placeholder="Why your department wants them" className="w-64" aria-label={`Why ${s.departmentCode} wants ${s.applicantName}`} />
                      <SubmitButton size="sm" pendingLabel="Sending…">Ask</SubmitButton>
                    </form>
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </section>
      )}

      {open && departments.length > 0 && (
        <Card className="space-y-4">
          <SectionHeader>{isManager ? "Add a dual appointment" : "Ask for a volunteer"}</SectionHeader>
          <p className="text-sm text-muted-foreground">
            {isManager
              ? "Approved as soon as you add it. They must hold an active application in this cycle, and a volunteer can serve in two departments at most."
              : "For someone who is not listed above. Enter the email or NetID they applied with."}
          </p>
          <form action={request} className="space-y-4">
            {isManager ? (
              <Field label="Volunteer" required>
                <Combobox
                  name="applicationId"
                  required
                  ariaLabel="Volunteer"
                  placeholder="Search by name or email"
                  options={applicantOptions.map((o) => ({ value: o.applicationId, label: o.label }))}
                />
              </Field>
            ) : (
              <Field label="Email or NetID" required>
                <Input name="identifier" required autoComplete="off" />
              </Field>
            )}
            <Field label={isManager ? "Second department" : "Your department"} required>
              <Select name="departmentCode" required defaultValue={departments.length === 1 ? departments[0].code : ""}>
                {departments.length > 1 && <option value="" disabled>Select…</option>}
                {departments.map((d) => (
                  <option key={d.code} value={d.code}>{d.name} ({d.code})</option>
                ))}
              </Select>
            </Field>
            <Field
              label="Why"
              required={!isManager}
              hint={isManager ? "Optional. The requesting department and the audit log keep it." : "A recruitment manager reads this before approving."}
            >
              <Textarea name="reason" rows={3} required={!isManager} />
            </Field>
            <FormActions>
              <SubmitButton pendingLabel="Saving…">{isManager ? "Add dual appointment" : "Send request"}</SubmitButton>
            </FormActions>
          </form>
        </Card>
      )}

      {closed.length > 0 && (
        <section className="space-y-3">
          <SectionHeader>Declined and cancelled</SectionHeader>
          <Table>
            <THead>
              <TR>
                <TH>Volunteer</TH>
                <TH>Department</TH>
                <TH>Outcome</TH>
                <TH>Note</TH>
              </TR>
            </THead>
            <tbody>
              {closed.map((r) => (
                <TR key={r.id}>
                  <TD className="font-medium">{r.applicantName}</TD>
                  <TD><Badge>{r.departmentCode}</Badge></TD>
                  <TD className="text-foreground-soft">
                    <Badge tone={STATUS_LABEL[r.status].tone}>{STATUS_LABEL[r.status].label}</Badge>
                    {r.decidedByName && <span className="block text-xs text-subtle-foreground">by {r.decidedByName}{r.decidedAt ? ` on ${date(r.decidedAt)}` : ""}</span>}
                  </TD>
                  <TD className="text-foreground-soft">{r.decisionNote ?? "-"}</TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </section>
      )}

      {isManager && nameOf.size === 0 && <EmptyState inline>No active departments.</EmptyState>}
    </PageBody>
  );
}

/** The volunteer's name, linked when the viewer may open the application. */
function VolunteerName({ row, cycleId }: { row: DualAppointmentRow; cycleId: string }) {
  return row.canOpenApplication ? (
    <TextLink href={`/recruitment/cycles/${cycleId}/applicants/${row.applicationId}`}>{row.applicantName}</TextLink>
  ) : (
    <>{row.applicantName}</>
  );
}
