"use client";

import { useState } from "react";

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
          <button
            key={p.value}
            type="button"
            onClick={() => setCronExpr(p.value)}
            className="rounded border border-dashed border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:border-slate-400 hover:text-slate-800"
          >
            {p.label}
          </button>
        ))}
      </div>
      <input
        id="cronExpr"
        name="cronExpr"
        type="text"
        value={cronExpr}
        onChange={(e) => setCronExpr(e.target.value)}
        placeholder="0 13 * * 1"
        required
        className="mt-0.5 w-48 rounded border border-slate-300 px-2 py-1.5 text-sm font-mono"
      />
    </div>
  );
}
