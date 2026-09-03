"use client";

/**
 * The applicant roster's "Department" filter. A single select driven off the URL
 * query string (soft-nav via useRouter), so the filtered view is shareable and
 * survives a refresh -- the same approach as its sibling DecisionFilter, and the
 * two compose because each rewrites only its own param.
 *
 * Options are handed down by the server from the roster itself (see
 * departmentFilterOptions), not from the cycle's department list, so the menu
 * never offers a department the viewer would find empty.
 */

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Field } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";

export function DepartmentFilter({ options }: { options: string[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const value = searchParams.get("department") ?? "";

  function onChange(next: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (next) params.set("department", next);
    else params.delete("department");
    // The prior page number may not exist under the new filter.
    params.delete("page");
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  // Nothing to choose between on a roster with no departments on it at all.
  if (options.length === 0) return null;

  return (
    <div className="w-48">
      <Field label="Department">
        <Select
          aria-label="Filter by department"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">All departments</option>
          {options.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  );
}
