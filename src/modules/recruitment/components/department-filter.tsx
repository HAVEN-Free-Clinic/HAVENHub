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

import { useSearchParams } from "next/navigation";
import { Field } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { ROW_WIDTH } from "@/platform/ui/form";
import { useNavFilter } from "@/platform/ui/nav-form";

export function DepartmentFilter({ options }: { options: string[] }) {
  const searchParams = useSearchParams();
  const navFilter = useNavFilter();
  const value = searchParams.get("department") ?? "";

  // useNavFilter reports the navigation to ListPendingProvider, which is what
  // dims the table while the server re-queries. A bare router.push did not, so
  // this filter changed nothing on screen until the new rows arrived.
  function onChange(next: string) {
    navFilter((params) => {
      if (next) params.set("department", next);
      else params.delete("department");
    });
  }

  // Nothing to choose between on a roster with no departments on it at all.
  if (options.length === 0) return null;

  return (
    <div className={ROW_WIDTH.control}>
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
