"use client";

/**
 * The applicant roster's "Decision" filter. A single select driven off the URL
 * query string (soft-nav via useRouter), so the filtered view is shareable and
 * survives a refresh -- same approach as the support RequestFilters bar. Its
 * option values are exactly the `rosterDecision` statuses, so the server page
 * filters with a direct `rosterDecision(a).status === decision` compare.
 */

import { useSearchParams } from "next/navigation";
import { Field } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { ROW_WIDTH } from "@/platform/ui/form";
import { useNavFilter } from "@/platform/ui/nav-form";

export const DECISION_FILTER_OPTIONS = [
  { value: "", label: "All decisions" },
  { value: "ACCEPTED", label: "Accepted" },
  { value: "WAITLIST", label: "Waitlisted" },
  { value: "REJECTED", label: "Rejected" },
  { value: "NONE", label: "Undecided" },
] as const;

export function DecisionFilter() {
  const searchParams = useSearchParams();
  const navFilter = useNavFilter();
  const value = searchParams.get("decision") ?? "";

  // useNavFilter reports the navigation to ListPendingProvider, which is what
  // dims the table while the server re-queries. A bare router.push did not, so
  // this filter changed nothing on screen until the new rows arrived.
  function onChange(next: string) {
    navFilter((params) => {
      if (next) params.set("decision", next);
      else params.delete("decision");
    });
  }

  return (
    <div className={ROW_WIDTH.control}>
      <Field label="Decision">
        <Select aria-label="Filter by decision" value={value} onChange={(e) => onChange(e.target.value)}>
          {DECISION_FILTER_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  );
}
