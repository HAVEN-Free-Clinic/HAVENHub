"use client";

/**
 * The applicant roster's "Language" filter: the rows the interpreting
 * department still owes a verdict on, or the rows it has finished.
 *
 * Same URL-driven shape as its siblings DecisionFilter and DepartmentFilter,
 * and the three compose because each rewrites only its own param. Rendered only
 * on a cycle that touches a department assessing language before it decides
 * (see services/applicant-language.ts), so it never offers a filter that would
 * match every row or none.
 */

import { useSearchParams } from "next/navigation";
import { Field } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { ROW_WIDTH } from "@/platform/ui/form";
import { useNavFilter } from "@/platform/ui/nav-form";

export const LANGUAGE_FILTER_OPTIONS = [
  { value: "", label: "All language reviews" },
  { value: "awaiting", label: "Awaiting assessment" },
  { value: "assessed", label: "Assessed" },
] as const;

export function LanguageFilter() {
  const searchParams = useSearchParams();
  const navFilter = useNavFilter();
  const value = searchParams.get("language") ?? "";

  // useNavFilter reports the navigation to ListPendingProvider, which dims the
  // table while the server re-queries; a bare router.push does not.
  function onChange(next: string) {
    navFilter((params) => {
      if (next) params.set("language", next);
      else params.delete("language");
    });
  }

  return (
    <div className={ROW_WIDTH.control}>
      <Field label="Language">
        <Select aria-label="Filter by language assessment" value={value} onChange={(e) => onChange(e.target.value)}>
          {LANGUAGE_FILTER_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  );
}
