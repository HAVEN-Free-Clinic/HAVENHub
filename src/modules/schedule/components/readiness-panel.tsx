/**
 * RHD Clinic Readiness panel for the schedule builder Saturday view.
 *
 * Shows who is covering the selected date and the computed readiness readout
 * from ClinicReadiness. Read-only: attendings are scheduled at
 * /schedule/attendings, which covers every service line. The coverage is still
 * shown here because readiness is computed FROM it, and a director building a
 * schedule needs to see whether the procedures booked are actually covered.
 *
 * Server component: no "use client" directive.
 */

import Link from "next/link";
import { Badge } from "@/platform/ui/badge";
import { cardClasses } from "@/platform/ui/card";
import { PROCEDURE_KEYS } from "@/modules/schedule/engine/rhd";
import type { BuilderRhd } from "@/modules/schedule/services/builder";
import type { ProcedureKey, ProcedureStatus } from "@/modules/schedule/engine/rhd";
import { SectionHeader } from "@/platform/ui/section-header";

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
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ReadinessPanel({ rhd }: ReadinessPanelProps) {
  const { readiness, clinic, attendingOptions } = rhd;
  // Resolved from the options rather than a join. attendingOptions holds the
  // ACTIVE roster, so a deactivated attending reads as "Not set" here, matching
  // the attending schedule's rule: naming someone who no longer covers would
  // read as a filled slot when it is really a gap to fill.
  const attendingName =
    attendingOptions.find((a) => a.id === clinic?.attendingId)?.scheduleName ?? null;

  return (
    <section className={`${cardClasses({ pad: false })} px-4 py-3 flex flex-col gap-4`}>
      <SectionHeader as="h2" level="title" className="text-sm">RHD Clinic Readiness</SectionHeader>

      {/* Who is covering. Read-only: /schedule/attendings owns this row now, for
          every service line, so there is exactly one form that writes it. */}
      <dl className="flex flex-col gap-1 text-sm">
        <div className="flex gap-2">
          <dt className="text-muted-foreground">Attending</dt>
          <dd className={attendingName ? "text-foreground" : "text-subtle-foreground"}>
            {attendingName ?? "Not set"}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-muted-foreground">Director</dt>
          <dd className={clinic?.directorName ? "text-foreground" : "text-subtle-foreground"}>
            {clinic?.directorName ?? "Not set"}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-muted-foreground">Procedures booked</dt>
          <dd className={clinic?.proceduresBooked != null ? "text-foreground" : "text-subtle-foreground"}>
            {clinic?.proceduresBooked ?? "Not set"}
          </dd>
        </div>
      </dl>
      <Link href="/schedule/attendings" className="text-xs text-brand-fg hover:underline">
        Schedule attendings
      </Link>

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

        {/* Clinic emails */}
        {readiness.emails.length > 0 && (
          <p className="text-sm text-foreground-soft break-words [overflow-wrap:anywhere]">
            <span className="font-medium">Clinic emails:</span>{" "}
            {readiness.emails.join(", ")}
          </p>
        )}
      </div>
    </section>
  );
}
