"use client";

import { useState } from "react";
import { Input } from "@/platform/ui/input";
import { SubmitButton } from "@/platform/ui/submit-button";

const MAX_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Today's date in New Haven as YYYY-MM-DD, the same on server and browser. */
function clinicToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
}

function addDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  return new Date(d.getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

function daysBetween(fromYmd: string, toYmd: string): number {
  return Math.round(
    (new Date(`${toYmd}T12:00:00Z`).getTime() - new Date(`${fromYmd}T12:00:00Z`).getTime()) / DAY_MS,
  );
}

/**
 * Grant form for one EHS item. The length can be set either as a number of days
 * or by picking the end date on the calendar; each updates the other. Only the
 * date is submitted, and the server turns it into the end of that day in New
 * Haven. The server re-checks every limit; the min/max here only keep the
 * picker honest.
 */
export function ProvisionalGrantForm({
  action,
  trainingId,
  itemName,
  personName,
  defaultDays = 7,
}: {
  action: (formData: FormData) => Promise<void>;
  trainingId: string;
  itemName: string;
  personName: string;
  defaultDays?: number;
}) {
  const today = clinicToday();
  const [days, setDays] = useState(String(defaultDays));
  const [endDate, setEndDate] = useState(addDays(today, defaultDays));

  function onDaysChange(value: string) {
    setDays(value);
    const n = Number(value);
    if (Number.isInteger(n) && n >= 1 && n <= MAX_DAYS) setEndDate(addDays(today, n));
  }

  function onDateChange(value: string) {
    setEndDate(value);
    if (value) setDays(String(daysBetween(today, value)));
  }

  return (
    <form action={action} className="mt-2 grid gap-2 sm:grid-cols-[6rem_10rem_1fr_auto] sm:items-end">
      <input type="hidden" name="trainingId" value={trainingId} />
      <label className="text-xs text-subtle-foreground">
        Days
        <Input
          type="number"
          min={1}
          max={MAX_DAYS}
          value={days}
          onChange={(e) => onDaysChange(e.target.value)}
          aria-label={`Number of days of provisional clearance for ${itemName}`}
        />
      </label>
      <label className="text-xs text-subtle-foreground">
        Until
        <Input
          type="date"
          name="expiresOn"
          required
          min={addDays(today, 1)}
          max={addDays(today, MAX_DAYS)}
          value={endDate}
          onChange={(e) => onDateChange(e.target.value)}
        />
      </label>
      <label className="text-xs text-subtle-foreground">
        Reason
        <Input name="reason" required placeholder="TB test taken 10/7, result pending" />
      </label>
      <SubmitButton
        size="sm"
        variant="outline"
        pendingLabel="Granting…"
        aria-label={`Grant provisional ${itemName} clearance to ${personName}`}
      >
        Grant
      </SubmitButton>
    </form>
  );
}