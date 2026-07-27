"use client";

import { useState } from "react";
import { Input } from "@/platform/ui/input";

// The cron field is evaluated in UTC (see the helper text under the input), so
// present the presets as their UTC value while labelling the Eastern time an admin
// actually means. 13:00 UTC is ~9:00 AM ET (9 AM EDT in summer, 8 AM EST in winter --
// a fixed cron cannot track DST). Previously these emitted 0 9 * * * ("09:00" label)
// which fired at 05:00/04:00 ET, contradicting the label and the helper text (#80).
const PRESETS = [
  { label: "Weekly (Mon ~9 AM ET)", value: "0 13 * * 1" },
  { label: "Daily (~9 AM ET)", value: "0 13 * * *" },
  { label: "Weekdays (~9 AM ET)", value: "0 13 * * 1-5" },
] as const;

export function CronPresets() {
  const [cronExpr, setCronExpr] = useState("");

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map((p) => (
          // eslint-disable-next-line no-restricted-syntax -- preset selector chip (dashed border, not a standard Button); border/padding overrides unreliable without tailwind-merge
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
