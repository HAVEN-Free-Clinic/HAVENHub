/**
 * Capacity panel for the schedule builder Saturday view.
 *
 * Displays headcount status, role quotas (triage/walk-in per dept),
 * shadow count, Spanish-speaker count, and patients booked inline form.
 *
 * Server component: no "use client" directive.
 */

import { Badge } from "@/platform/ui/badge";
import { Button } from "@/platform/ui/button";
import { cardClasses } from "@/platform/ui/card";
import { Input, Field } from "@/platform/ui/input";
import { rolesForDept } from "@/modules/schedule/engine/capacity";
import type { DayMetrics, Quota } from "@/modules/schedule/engine/capacity";

// ---------------------------------------------------------------------------
// Tone helpers
// ---------------------------------------------------------------------------

function headcountTone(
  status: DayMetrics["headcountStatus"],
): "warning" | "success" | "default" {
  if (status === "at") return "success";
  if (status === "under" || status === "over") return "warning";
  return "default";
}

function quotaTone(q: Quota): "critical" | "success" | "warning" {
  if (q === "missing") return "critical";
  if (q === "ok") return "success";
  return "warning";
}

function quotaLabel(q: Quota): string {
  if (q === "missing") return "Missing";
  if (q === "ok") return "OK";
  return "Excess";
}

// Human-readable headcount status copy (keeps raw status for tone logic).
const HEADCOUNT_LABELS: Record<DayMetrics["headcountStatus"], string> = {
  under: "Understaffed",
  over: "Overstaffed",
  at: "At target",
  unknown: "No target",
};

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type CapacityPanelProps = {
  metrics: DayMetrics;
  deptCode: string;
  patientsBookedAction: (fd: FormData) => Promise<void>;
  departmentId: string;
  dateKey: string;
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CapacityPanel({
  metrics,
  deptCode,
  patientsBookedAction,
  departmentId,
  dateKey,
}: CapacityPanelProps) {
  const roles = rolesForDept(deptCode);

  return (
    <section className={`${cardClasses({ pad: false })} px-4 py-3 flex flex-col gap-3`}>
      <h2 className="text-sm font-semibold text-foreground-soft">Capacity</h2>

      {/* Headcount */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-foreground-soft">
          {metrics.headcount} / {metrics.idealHeadcount ?? "-"} on shift
        </span>
        <Badge tone={headcountTone(metrics.headcountStatus)}>
          {HEADCOUNT_LABELS[metrics.headcountStatus]}
        </Badge>
      </div>

      {/* Role quota badges -- triage and/or walk-in only (cc has no DayMetrics field; skip silently) */}
      {roles.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {roles.includes("triage") && (
            <Badge tone={quotaTone(metrics.triageStatus)}>
              Triage: {quotaLabel(metrics.triageStatus)}
            </Badge>
          )}
          {roles.includes("walkin") && (
            <Badge tone={quotaTone(metrics.walkinStatus)}>
              Walk-in: {quotaLabel(metrics.walkinStatus)}
            </Badge>
          )}
          {/* "cc" is a valid MedRole but has no corresponding DayMetrics field; skipped */}
        </div>
      )}

      {/* Shadow and Spanish counts */}
      <div className="flex flex-col gap-1 text-sm text-foreground-soft">
        <span>Shadows: {metrics.shadowCount}</span>
        <span>Spanish speakers: {metrics.spanishCount}</span>
      </div>

      {/* Patients booked inline form */}
      <form action={patientsBookedAction} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="departmentId" value={departmentId} />
        <input type="hidden" name="dateKey" value={dateKey} />
        <div className="flex-1 min-w-28">
          <Field label="Patients booked">
            <Input
              name="patientsBooked"
              type="number"
              min={0}
              defaultValue={metrics.patientsBooked ?? ""}
              placeholder="-"
            />
          </Field>
        </div>
        <Button type="submit" variant="outline" size="sm">
          Save
        </Button>
      </form>

      {/* Max patient capacity */}
      {metrics.maxPatientCapacity != null && (
        <p className="text-sm text-muted-foreground">
          Max capacity: {metrics.maxPatientCapacity} patients
        </p>
      )}

      {/* Patients to reschedule warning */}
      {metrics.patientsToReschedule != null && metrics.patientsToReschedule > 0 && (
        <Badge tone="critical">
          Patients to reschedule: {metrics.patientsToReschedule}
        </Badge>
      )}
    </section>
  );
}
