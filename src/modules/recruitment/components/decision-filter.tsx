"use client";

/**
 * The applicant roster's "Decision" filter. A single select driven off the URL
 * query string (soft-nav via useRouter), so the filtered view is shareable and
 * survives a refresh -- same approach as the support RequestFilters bar. Its
 * option values are exactly the `rosterDecision` statuses, so the server page
 * filters with a direct `rosterDecision(a).status === decision` compare.
 */

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Field } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";

export const DECISION_FILTER_OPTIONS = [
  { value: "", label: "All decisions" },
  { value: "ACCEPTED", label: "Accepted" },
  { value: "WAITLIST", label: "Waitlisted" },
  { value: "REJECTED", label: "Rejected" },
  { value: "NONE", label: "Undecided" },
] as const;

export function DecisionFilter() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const value = searchParams.get("decision") ?? "";

  function onChange(next: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (next) params.set("decision", next);
    else params.delete("decision");
    // The prior page number may not exist under the new filter.
    params.delete("page");
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  return (
    <div className="w-48">
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
