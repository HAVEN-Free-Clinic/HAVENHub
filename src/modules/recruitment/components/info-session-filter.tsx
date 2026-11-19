"use client";

/**
 * The applicant roster's info-session filter: everyone flagged for rejection
 * because they attended no info session (engine/info-session.ts). Same
 * URL-driven shape as DecisionFilter and LanguageFilter, rewriting only its own
 * `info` param. Rendered only on a cycle that has info sessions.
 */

import { useSearchParams } from "next/navigation";
import { Field } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { ROW_WIDTH } from "@/platform/ui/form";
import { useNavFilter } from "@/platform/ui/nav-form";

export const INFO_SESSION_FILTER_OPTIONS = [
  { value: "", label: "All applicants" },
  { value: "flagged", label: "Flagged: no info session" },
] as const;

export function InfoSessionFilter() {
  const searchParams = useSearchParams();
  const navFilter = useNavFilter();
  const value = searchParams.get("info") ?? "";

  function onChange(next: string) {
    navFilter((params) => {
      if (next) params.set("info", next);
      else params.delete("info");
    });
  }

  return (
    <div className={ROW_WIDTH.control}>
      <Field label="Info session">
        <Select aria-label="Filter by info session attendance" value={value} onChange={(e) => onChange(e.target.value)}>
          {INFO_SESSION_FILTER_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  );
}
