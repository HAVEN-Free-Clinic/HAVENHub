"use client";

import { Input, Field } from "@/platform/ui/input";
import { Alert } from "@/platform/ui/alert";
import { SubmitButton } from "./submit-button";
import { CronPresets } from "./cron-presets";
import { useFormDirty } from "./use-form-dirty";

type FormAction = (formData: FormData) => void | Promise<void>;

/**
 * Schedule-for-later and Recurring controls for a draft campaign.
 *
 * Like Preview/Test/Send, scheduling reads the LAST SAVED campaign from the
 * database (scheduleCampaign re-fetches it), so scheduling with unsaved compose
 * edits would silently schedule stale content -- and once scheduled the campaign
 * can only be cancelled, never edited, so those edits are lost for good. We watch
 * the compose form and disable both submits (plus show a notice) while it is dirty,
 * exactly as ReviewActions does for sending.
 */
export function TimingActions({
  formId,
  scheduleLaterAction,
  scheduleRecurringAction,
  zoneLabel,
}: {
  formId: string;
  scheduleLaterAction: FormAction;
  scheduleRecurringAction: FormAction;
  zoneLabel: string;
}) {
  const dirty = useFormDirty(formId);

  return (
    <div className="space-y-5">
      {/* Schedule for later */}
      <div className="space-y-2">
        <p className="text-sm font-medium text-foreground-soft">Schedule for later</p>
        <form action={scheduleLaterAction} className="flex flex-wrap items-end gap-3">
          <Field label={`Send at (${zoneLabel})`}>
            <Input name="scheduledAt" type="datetime-local" required className="w-auto" />
          </Field>
          <Field label="Confirm count (required for >25 recipients)">
            <Input name="confirmCount" type="number" min={1} placeholder="e.g. 42" className="w-24" />
          </Field>
          <SubmitButton pendingLabel="Scheduling..." disabled={dirty}>
            Schedule
          </SubmitButton>
        </form>
        <p className="text-xs text-muted-foreground">The send time is interpreted in {zoneLabel}.</p>
      </div>

      {/* Recurring */}
      <div className="space-y-2">
        <p className="text-sm font-medium text-foreground-soft">Recurring</p>
        <form action={scheduleRecurringAction} className="flex flex-wrap items-end gap-3">
          <Field label="Cron expression">
            <CronPresets />
          </Field>
          <Field label="Confirm count (required for >25 recipients)">
            <Input name="confirmCount" type="number" min={1} placeholder="e.g. 42" className="w-24" />
          </Field>
          <SubmitButton pendingLabel="Starting..." disabled={dirty}>
            Start recurring
          </SubmitButton>
        </form>
        <p className="text-xs text-muted-foreground">
          Cron format: minute hour day month weekday, evaluated in UTC (recurring schedules run on
          UTC, independent of the display zone). Example: <code className="font-mono">0 13 * * 1</code>{" "}
          = Mondays 13:00 UTC (9:00 AM ET in summer).
        </p>
      </div>

      {dirty && (
        <Alert tone="warning">
          Save your changes before scheduling. Scheduling uses the last saved version of this
          campaign, and a scheduled campaign can no longer be edited.
        </Alert>
      )}
    </div>
  );
}
