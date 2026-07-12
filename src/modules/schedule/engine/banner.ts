/**
 * Clearance banner summarizer for the schedule view.
 *
 * Returns only departments with at least one scheduled volunteer who is not fully
 * cleared to volunteer (any outstanding onboarding/clearance item: profile, HIPAA,
 * training, learning, or EHS), so a director can see who cannot work that date.
 */

export type BannerVolunteer = { id: string; name: string };

export type DeptBanner = {
  departmentId: string;
  departmentName: string;
  notCleared: BannerVolunteer[];
};

/**
 * Departments with at least one scheduled volunteer who is not cleared; fully
 * cleared departments are omitted. Input order is preserved.
 */
export function summarizeNotCleared(
  depts: Array<{
    departmentId: string;
    departmentName: string;
    volunteers: Array<{ id: string; name: string; cleared: boolean }>;
  }>,
): DeptBanner[] {
  const result: DeptBanner[] = [];

  for (const dept of depts) {
    const notCleared = dept.volunteers
      .filter((v) => !v.cleared)
      .map((v) => ({ id: v.id, name: v.name }));

    if (notCleared.length === 0) continue;

    result.push({
      departmentId: dept.departmentId,
      departmentName: dept.departmentName,
      notCleared,
    });
  }

  return result;
}
