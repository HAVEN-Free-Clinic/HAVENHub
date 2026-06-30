"use client";

import { useState } from "react";
import { Input } from "@/platform/ui/input";

const PRESETS = [
  { label: "Weekly (Mon 09:00)", value: "0 9 * * 1" },
  { label: "Daily (09:00)", value: "0 9 * * *" },
  { label: "Weekdays (09:00)", value: "0 9 * * 1-5" },
] as const;

export function CronPresets() {
  const [cronExpr, setCronExpr] = useState("");

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map((p) => (
          // eslint-disable-next-line no-restricted-syntax -- cron-preset chip, dashed-border selector chip styling
          <button key={p.value} type="button" onClick={() => setCronExpr(p.value)} className="rounded-lg border border-dashed border-border-strong px-3 py-1.5 text-sm text-foreground-soft hover:border-border-strong hover:text-foreground">
            {p.label}
          </button>
        ))}
      </div>
      <Input
        id="cronExpr"
        name="cronExpr"
        type="text"
        value={cronExpr}
        onChange={(e) => setCronExpr(e.target.value)}
        placeholder="0 13 * * 1"
        required
        className="mt-0.5 w-48 font-mono"
      />
    </div>
  );
}
