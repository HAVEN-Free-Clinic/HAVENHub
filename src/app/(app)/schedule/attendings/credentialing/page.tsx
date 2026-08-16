import Link from "next/link";
import { redirect } from "next/navigation";
import { requireModuleAccess } from "@/platform/auth/session";
import { canManageAttendings } from "@/modules/schedule/services/attendings";
import {
  listCredentialing,
  updateCredentialing,
  outstandingSteps,
  CREDENTIALING_STEPS,
  VOLUNTEER_NOTE,
} from "@/modules/schedule/services/credentialing";
import {
  AttendingForbiddenError,
  AttendingValidationError,
} from "@/modules/schedule/services/attendings";
import { runAction } from "@/platform/actions";
import { PageHeader } from "@/platform/ui/page-header";
import { Alert } from "@/platform/ui/alert";
import { Badge } from "@/platform/ui/badge";
import { Button } from "@/platform/ui/button";
import { Card } from "@/platform/ui/card";
import { Checkbox } from "@/platform/ui/checkbox";
import { Input } from "@/platform/ui/input";
import { SectionHeader } from "@/platform/ui/section-header";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";

/**
 * Attending credentialing, the pipeline Faculty Relations runs before a new
 * attending can work a clinic.
 *
 * One row per attending with the stages as checkboxes, because that is how the
 * work is actually tracked: stages complete out of order and in parallel. The
 * documented process sits above the table so the tracker is not just a row of
 * boxes whose meaning lives in someone's head.
 */
type PageProps = {
  searchParams: Promise<{ message?: string }>;
};

/** The checkbox columns, in the order the process runs. */
const STAGES = [
  { field: "infoEmailSent", label: "Info email" },
  { field: "formsReceived", label: "Forms in" },
  { field: "npdbCheck", label: "NPDB" },
  { field: "oapd", label: "OAPD" },
  { field: "needsFtca", label: "FTCA needed" },
  { field: "ftcaSubmitted", label: "FTCA sent" },
  { field: "medDirectorApprovalNeeded", label: "Med dir needed" },
  { field: "medDirectorApproved", label: "Med dir OK" },
  { field: "steeringCommitteeApprovalNeeded", label: "Steering needed" },
  { field: "steeringCommitteeApproved", label: "Steering OK" },
  { field: "approved", label: "Approved" },
] as const;

export default async function CredentialingPage({ searchParams }: PageProps) {
  const session = await requireModuleAccess("schedule");
  const { message } = await searchParams;

  if (!(await canManageAttendings(session.personId))) redirect("/no-access");

  const rows = await listCredentialing();

  async function saveAction(formData: FormData) {
    "use server";
    const actor = await requireModuleAccess("schedule");
    const attendingId = String(formData.get("attendingId") ?? "");

    await runAction({
      work: () =>
        updateCredentialing(actor.personId, attendingId, {
          // Every checkbox the row rendered is posted as present-or-absent, so
          // an unchecked box reads as false rather than "leave it alone".
          ...Object.fromEntries(STAGES.map((s) => [s.field, formData.get(s.field) === "on"])),
          notes: String(formData.get("notes") ?? ""),
        }),
      domainErrors: [AttendingValidationError, AttendingForbiddenError],
      errorRedirect: (m) => `/schedule/attendings/credentialing?message=${encodeURIComponent(m)}`,
      revalidate: "/schedule/attendings/credentialing",
      successRedirect: "/schedule/attendings/credentialing",
    });
  }

  // Someone with no row has not been started; someone approved is done. What is
  // left is the working list, which is what this page is for.
  const inProgress = rows.filter((r) => r.credentialing && !r.credentialing.approved);
  const notStarted = rows.filter((r) => !r.credentialing);
  const approved = rows.filter((r) => r.credentialing?.approved);

  return (
    <div className="space-y-8">
      <PageHeader
        title="Credentialing"
        description="Onboarding new attendings, from the first email through to approval."
      />

      {message && <Alert tone="error">{message}</Alert>}

      <section className="space-y-3">
        <SectionHeader level="title">The process</SectionHeader>
        <Card className="space-y-3">
          <ol className="space-y-2">
            {CREDENTIALING_STEPS.map((step, i) => (
              <li key={step.title} className="text-sm">
                <span className="font-medium text-foreground">
                  {i + 1}. {step.title}
                </span>
                <span className="block text-muted-foreground">{step.detail}</span>
              </li>
            ))}
          </ol>
          <p className="rounded-xl border border-border bg-muted px-3 py-2 text-xs text-foreground-soft">
            {VOLUNTEER_NOTE}
          </p>
        </Card>
      </section>

      <section className="space-y-3">
        <SectionHeader level="title">
          In progress {inProgress.length > 0 && `(${inProgress.length})`}
        </SectionHeader>
        {inProgress.length === 0 ? (
          <Card pad={false} className="px-6 py-10 text-center text-sm text-muted-foreground">
            Nobody is mid-credentialing. Start someone from the not-started list below.
          </Card>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <TR>
                  <TH>Attending</TH>
                  {STAGES.map((s) => (
                    <TH key={s.field}>{s.label}</TH>
                  ))}
                  <TH>Notes</TH>
                  <TH>
                    <span className="sr-only">Save</span>
                  </TH>
                </TR>
              </THead>
              <tbody>
                {inProgress.map((row) => {
                  const outstanding = outstandingSteps(row.credentialing);
                  return (
                    <TR key={row.attendingId}>
                      <TD className="align-top">
                        <form action={saveAction} id={`cred-${row.attendingId}`}>
                          <input type="hidden" name="attendingId" value={row.attendingId} />
                        </form>
                        <Link
                          href={`/schedule/attendings/${row.attendingId}`}
                          className="font-medium text-brand-fg hover:underline"
                        >
                          {row.scheduleName}
                        </Link>
                        <span className="block text-xs text-subtle-foreground">
                          {row.specialtyName ?? "No specialty"}
                        </span>
                        {outstanding.length > 0 && (
                          <span className="mt-1 block text-xs text-muted-foreground">
                            Waiting on: {outstanding.join(", ")}
                          </span>
                        )}
                      </TD>
                      {STAGES.map((s) => (
                        <TD key={s.field} className="align-top text-center">
                          <Checkbox
                            name={s.field}
                            form={`cred-${row.attendingId}`}
                            defaultChecked={Boolean(row.credentialing?.[s.field])}
                            aria-label={`${s.label} for ${row.scheduleName}`}
                          />
                        </TD>
                      ))}
                      <TD className="align-top">
                        <Input
                          name="notes"
                          form={`cred-${row.attendingId}`}
                          defaultValue={row.credentialing?.notes ?? ""}
                          placeholder="Optional"
                          aria-label={`Notes for ${row.scheduleName}`}
                          className="text-sm"
                        />
                      </TD>
                      <TD className="align-top">
                        <Button
                          type="submit"
                          form={`cred-${row.attendingId}`}
                          variant="outline"
                          size="sm"
                        >
                          Save
                        </Button>
                      </TD>
                    </TR>
                  );
                })}
              </tbody>
            </Table>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <SectionHeader level="title">Not started ({notStarted.length})</SectionHeader>
        <p className="text-xs text-muted-foreground">
          On the roster with no credentialing recorded. Saving any stage starts tracking them.
        </p>
        {notStarted.length === 0 ? (
          <Card pad={false} className="px-6 py-10 text-center text-sm text-muted-foreground">
            Everyone on the roster has credentialing recorded.
          </Card>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <TR>
                  <TH>Attending</TH>
                  <TH>Specialty</TH>
                  <TH>Active</TH>
                  <TH>
                    <span className="sr-only">Start</span>
                  </TH>
                </TR>
              </THead>
              <tbody>
                {notStarted.map((row) => (
                  <TR key={row.attendingId}>
                    <TD>
                      <span className="font-medium text-foreground">{row.scheduleName}</span>
                      <span className="block text-xs text-subtle-foreground">{row.fullName}</span>
                    </TD>
                    <TD className="text-sm text-muted-foreground">{row.specialtyName ?? "Not set"}</TD>
                    <TD>
                      {row.isActive ? (
                        <Badge tone="success">Active</Badge>
                      ) : (
                        <Badge tone="default">Inactive</Badge>
                      )}
                    </TD>
                    <TD>
                      <form action={saveAction}>
                        <input type="hidden" name="attendingId" value={row.attendingId} />
                        {/* Starts tracking with the first stage ticked, which is
                            what beginning the process actually means. */}
                        <input type="hidden" name="infoEmailSent" value="on" />
                        <Button type="submit" variant="outline" size="sm">
                          Start
                        </Button>
                      </form>
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <SectionHeader level="title">Approved ({approved.length})</SectionHeader>
        {approved.length === 0 ? (
          <Card pad={false} className="px-6 py-10 text-center text-sm text-muted-foreground">
            Nobody has completed credentialing yet.
          </Card>
        ) : (
          <Card className="text-sm text-foreground-soft">
            {approved.map((r) => r.scheduleName).join(", ")}
          </Card>
        )}
      </section>
    </div>
  );
}
