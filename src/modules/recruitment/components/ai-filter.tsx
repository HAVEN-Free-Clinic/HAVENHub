"use client";

/**
 * The applicant roster's "AI review" filter, shown to recruitment leads only.
 * Same URL-driven select as DecisionFilter, on the `ai` param, so a filtered
 * view ("everyone the AI would re-route") is shareable and survives a refresh.
 */

import { useSearchParams } from "next/navigation";
import { Field } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { ROW_WIDTH } from "@/platform/ui/form";
import { useNavFilter } from "@/platform/ui/nav-form";
import { AI_ROSTER_FILTERS, AI_ROSTER_FILTER_LABELS } from "@/modules/recruitment/engine/ai-review";

export function AiFilter() {
  const searchParams = useSearchParams();
  const navFilter = useNavFilter();
  const value = searchParams.get("ai") ?? "";

  function onChange(next: string) {
    navFilter((params) => {
      if (next) params.set("ai", next);
      else params.delete("ai");
    });
  }

  return (
    <div className={ROW_WIDTH.control}>
      <Field label="AI review">
        <Select aria-label="Filter by AI review" value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">All</option>
          {AI_ROSTER_FILTERS.map((f) => (
            <option key={f} value={f}>
              {AI_ROSTER_FILTER_LABELS[f]}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  );
}
