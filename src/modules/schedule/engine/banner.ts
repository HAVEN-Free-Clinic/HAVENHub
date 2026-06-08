/**
 * HIPAA compliance banner summarizer for the schedule view.
 *
 * New module (no legacy equivalent). Returns only departments with at least
 * one scheduled volunteer whose compliance status is not COMPLIANT.
 */

import type { ComplianceStatus } from "@/platform/compliance/rules";

export type BannerVolunteer = { id: string; name: string };

export type DeptBanner = {
  departmentId: string;
  departmentName: string;
  nonCompliant: BannerVolunteer[];
};

/**
 * Departments with at least one scheduled volunteer whose HIPAA status is not
 * COMPLIANT; compliant departments are omitted. Input order is preserved.
 */
export function summarizeNonCompliant(
  depts: Array<{
    departmentId: string;
    departmentName: string;
    volunteers: Array<{ id: string; name: string; status: ComplianceStatus }>;
  }>,
): DeptBanner[] {
  const result: DeptBanner[] = [];

  for (const dept of depts) {
    const nonCompliant = dept.volunteers
      .filter((v) => v.status !== "COMPLIANT")
      .map((v) => ({ id: v.id, name: v.name }));

    if (nonCompliant.length === 0) continue;

    result.push({
      departmentId: dept.departmentId,
      departmentName: dept.departmentName,
      nonCompliant,
    });
  }

  return result;
}
