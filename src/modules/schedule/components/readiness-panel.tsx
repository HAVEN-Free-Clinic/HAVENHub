/**
 * RHD Clinic Readiness panel for the schedule builder Saturday view.
 *
 * Renders the clinic config form (attending, director, procedures booked)
 * and the computed readiness readout from ClinicReadiness.
 *
 * Server component: no "use client" directive.
 */

import Link from "next/link";
import { Badge } from "@/platform/ui/badge";
import { Button } from "@/platform/ui/button";
import { Input, Field } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { PROCEDURE_KEYS } from "@/modules/schedule/engine/rhd";
import type { BuilderRhd } from "@/modules/schedule/services/builder";
import type { ProcedureKey, ProcedureStatus } from "@/modules/schedule/engine/rhd";

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
  clinicAction: (fd: FormData) => Promise<void>;
  addAttendingAction: (fd: FormData) => Promise<void>;
  dateKey: string;
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ReadinessPanel({
  rhd,
  clinicAction,
  addAttendingAction,
  dateKey,
}: ReadinessPanelProps) {
  const { readiness, attendingOptions, clinic } = rhd;

  return (
    <section className="rounded-2xl border border-slate-200 bg-white px-4 py-3 flex flex-col gap-4">
      <h2 className="text-sm font-semibold text-slate-700">RHD Clinic Readiness</h2>

      {/* Clinic config form */}
      <form action={clinicAction} className="flex flex-col gap-3">
        <input type="hidden" name="dateKey" value={dateKey} />

        {/* Attending select */}
        <Field label="Attending">
          <Select name="attendingId" defaultValue={clinic?.attendingId ?? ""}>
            <option value="">-- none --</option>
            {attendingOptions.map((a) => (
              <option key={a.id} value={a.id}>
                {a.scheduleName}
              </option>
            ))}
          </Select>
        </Field>

        {/* Director name */}
        <Field label="Director name">
          <Input
            name="directorName"
            type="text"
            defaultValue={clinic?.directorName ?? ""}
            placeholder="-"
          />
        </Field>

        {/* Procedures booked */}
        <Field label="Procedures booked">
          <Input
            name="proceduresBooked"
            type="number"
            min={0}
            defaultValue={clinic?.proceduresBooked ?? ""}
            placeholder="-"
          />
        </Field>

        <Button type="submit" variant="outline" size="sm" className="self-start">
          Save clinic
        </Button>
      </form>

      {/* Quick-add a new attending */}
      <details className="text-xs">
        <summary className="cursor-pointer text-slate-500 hover:text-slate-700">&#xFF0B; Add attending</summary>
        <form action={addAttendingAction} className="mt-2 flex flex-col gap-2">
          <Input name="scheduleName" placeholder="Schedule name (e.g. Rivera)" required className="text-sm" />
          <Input name="fullName" placeholder="Full name (optional)" className="text-sm" />
          <Button type="submit" variant="outline" size="sm">Add</Button>
        </form>
      </details>
      <Link href="/schedule/attendings" className="text-xs text-brand hover:underline">
        Manage attendings
      </Link>

      {/* Readiness readout */}
      <div className="flex flex-col gap-3 border-t border-slate-100 pt-3">
        <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide">
          Readiness
        </h3>

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
        <p className="text-sm text-slate-600">
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
          <p className="text-sm text-slate-600 break-words [overflow-wrap:anywhere]">
            <span className="font-medium">Clinic emails:</span>{" "}
            {readiness.emails.join(", ")}
          </p>
        )}
      </div>
    </section>
  );
}
