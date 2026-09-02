/**
 * RHD Clinic Readiness panel for the schedule builder Saturday view.
 *
 * Shows who is covering the selected date and the computed readiness readout
 * from ClinicReadiness. Attendings are read-only here: they are scheduled at
 * /schedule/attendings, which covers every service line, so there is exactly one
 * form that writes them. The coverage is still shown because readiness is
 * computed FROM it, and a director building a schedule needs to see whether the
 * procedures booked are actually covered.
 *
 * Procedures booked is the exception, and deliberately so. It is the
 * reproductive health director's number, not Faculty Relations'; it only ever
 * sat on the attending form because that form owned the whole ClinicDay row. It
 * is edited here, where the person who knows it is already working.
 *
 * Server component: no "use client" directive.
 */

import Link from "next/link";
import { Badge } from "@/platform/ui/badge";
import { Button } from "@/platform/ui/button";
import { cardClasses } from "@/platform/ui/card";
import { Field, Input } from "@/platform/ui/input";
import { PROCEDURE_KEYS } from "@/modules/schedule/engine/rhd";
import type { BuilderRhd } from "@/modules/schedule/services/builder";
import type { ProcedureKey, ProcedureStatus } from "@/modules/schedule/engine/rhd";
import { SectionHeader } from "@/platform/ui/section-header";
import { EmailList } from "@/platform/ui/email-list";

// ---------------------------------------------------------------------------
// Label maps
// ---------------------------------------------------------------------------

const PROCEDURE_LABELS: Record<ProcedureKey, string> = {
  iudIn: "IUD In",
  iudOut: "IUD Out",
  nexplanon: "Nexplanon",
  gac: "GAC",
  emb: "EMB",
  seesMale: "Sees Male",
};

// ---------------------------------------------------------------------------
// Tone helpers
// ---------------------------------------------------------------------------

function procedureTone(
  status: ProcedureStatus,
): "success" | "critical" | "default" {
  if (status === "yes") return "success";
  if (status === "no") return "critical";
  return "default";
}

// Readable copy for the raw procedure status enum (keeps values for tone logic).
const PROCEDURE_STATUS_LABELS: Record<ProcedureStatus, string> = {
  yes: "Yes",
  no: "No",
  unknown: "N/A",
};

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type ReadinessPanelProps = {
  rhd: BuilderRhd;
  /**
   * Whether the viewer maintains the attending schedule
   * (schedule.manage_attendings). Only they are offered the link: /schedule/attendings
   * bounces everyone else to /no-access, and the nav tab is already dropped for
   * them, so an ungated link here was the one route into a dead end.
   */
  canManageAttendings: boolean;
  /**
   * The directors whose profile this viewer may open (see
   * platform/member-profile). A plain Set: this is a server component rendering
   * inside another server component, so nothing crosses a serialization
   * boundary. Anyone absent renders as text, not a link that would bounce.
   */
  profilePersonIds: Set<string>;
  /** False on an archived term: the readout still renders, the form does not. */
  editable: boolean;
  departmentId: string;
  dateKey: string;
  proceduresBookedAction: (fd: FormData) => Promise<void>;
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ReadinessPanel({
  rhd,
  canManageAttendings,
  profilePersonIds,
  editable,
  departmentId,
  dateKey,
  proceduresBookedAction,
}: ReadinessPanelProps) {
  const { readiness, clinic, directors } = rhd;

  return (
    <section className={`${cardClasses({ pad: false })} px-4 py-3 flex flex-col gap-4`}>
      <SectionHeader as="h2" level="title" className="text-sm">RHD Clinic Readiness</SectionHeader>

      {/* Who is covering. Read-only: /schedule/attendings owns this row now, for
          every service line, so there is exactly one form that writes it. */}
      <dl className="flex flex-col gap-1 text-sm">
        <div className="flex gap-2">
          {/* Plural: a service line can split its day into named slots and staff
              each separately, so a Saturday may carry more than one attending.
              A deactivated one is absent here, the same gap the schedule shows. */}
          <dt className="text-muted-foreground">
            {readiness.attendings.length > 1 ? "Attendings" : "Attending"}
          </dt>
          <dd className={readiness.attendings.length > 0 ? "text-foreground" : "text-subtle-foreground"}>
            {readiness.attendings.length === 0
              ? "Not set"
              : readiness.attendings
                  .map((a) => (a.slotLabel ? `${a.scheduleName} (${a.slotLabel})` : a.scheduleName))
                  .join(", ")}
          </dd>
        </div>
        <div className="flex gap-2">
          {/* Read off the schedule, not typed. There used to be a free-text
              "director on point" field beside it on the attending form; two
              places to say who is directing was only ever a way for the two to
              disagree, and the schedule is the one that is kept current. */}
          <dt className="text-muted-foreground">
            {directors.length > 1 ? "Directors" : "Director"}
          </dt>
          <dd className={directors.length > 0 || clinic?.directorName ? "text-foreground" : "text-subtle-foreground"}>
            {directors.length > 0 ? (
              directors.map((d, i) => (
                <span key={d.id}>
                  {i > 0 && ", "}
                  {profilePersonIds.has(d.id) ? (
                    <Link
                      href={`/volunteers/compliance/${d.id}`}
                      className="text-brand-fg hover:underline"
                    >
                      {d.name}
                    </Link>
                  ) : (
                    d.name
                  )}
                </span>
              ))
            ) : (
              // The stored name, for a historical date imported from Airtable
              // before the schedule carried directors. Nothing writes it now.
              clinic?.directorName ?? "Not scheduled"
            )}
          </dd>
        </div>
      </dl>

      {/* Procedures booked. An inline form rather than a read-only row: it feeds
          the cap warning below it, and the person who knows the number is the
          one reading this panel. */}
      {editable ? (
        <form action={proceduresBookedAction} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="departmentId" value={departmentId} />
          <input type="hidden" name="dateKey" value={dateKey} />
          {/* Field + Save, laid out exactly like the Patients booked control in
              the capacity panel directly above it in this sidebar. */}
          <div className="flex-1 min-w-28">
            <Field label="Procedures booked">
              <Input
                name="proceduresBooked"
                type="number"
                min={0}
                defaultValue={clinic?.proceduresBooked ?? ""}
                placeholder="-"
              />
            </Field>
          </div>
          <Button type="submit" variant="outline" size="sm">
            Save
          </Button>
        </form>
      ) : (
        <div className="flex gap-2 text-sm">
          <span className="text-muted-foreground">Procedures booked</span>
          <span className={clinic?.proceduresBooked != null ? "text-foreground" : "text-subtle-foreground"}>
            {clinic?.proceduresBooked ?? "Not set"}
          </span>
        </div>
      )}

      {canManageAttendings && (
        <Link href="/schedule/attendings" className="text-xs text-brand-fg hover:underline">
          Schedule attendings
        </Link>
      )}

      {/* Readiness readout */}
      <div className="flex flex-col gap-3 border-t border-border-subtle pt-3">
        <SectionHeader as="h3">Readiness</SectionHeader>

        {/* Closed badge */}
        {readiness.closed && (
          <Badge tone="warning">Closed</Badge>
        )}

        {/* Procedure matrix */}
        <div className="flex flex-wrap gap-2">
          {PROCEDURE_KEYS.map((key) => {
            const status = readiness.procedures[key];
            return (
              <Badge key={key} tone={procedureTone(status)}>
                {PROCEDURE_LABELS[key]}: {PROCEDURE_STATUS_LABELS[status]}
              </Badge>
            );
          })}
        </div>

        {/* Coverage line */}
        <p className="text-sm text-foreground-soft">
          SCTM {readiness.coverage.sctm}, JCTM {readiness.coverage.jctm},{" "}
          RN {readiness.coverage.rn}, Spanish {readiness.coverage.spanish}
        </p>

        {/* Depo badge */}
        <Badge tone={readiness.depoOk ? "success" : "critical"}>
          {readiness.depoOk ? "Depo OK" : "No RN for Depo"}
        </Badge>

        {/* Procedure cap warning */}
        {readiness.procedureCapWarning && (
          <Badge tone="critical">Over procedure cap</Badge>
        )}

        {/* Clinic emails. Spans all three RHD departments, unlike the shift list
            in the sidebar above, which is the selected department alone. */}
        {readiness.emails.length > 0 && (
          <EmailList emails={readiness.emails} label="Clinic emails (all RHD)" />
        )}
      </div>
    </section>
  );
}
