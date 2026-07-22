import type { Track } from "@prisma/client";
import { prisma } from "@/platform/db";
import { getSetting } from "@/platform/settings/service";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import { formatTrainingDate, formatTrainingLocation } from "@/app/onboard/[token]/training-date";
import type { OnboardingPreviewContext } from "./onboarding-preview";

/**
 * Build the context the onboarding preview needs: the selectable departments
 * (with their Epic-requirement flags so the preview can derive the requirement
 * per track), the org name and training strings for {{...}} interpolation, and a
 * server-stamped todayIso for the HIPAA date bounds. `departmentCodes: "all"`
 * loads every active department (global master-template editor); an array loads
 * exactly a cycle's departments.
 */
export async function loadOnboardingPreviewContext(opts: {
  departmentCodes: string[] | "all";
  fixedTrack: Track | null;
  inPersonTrainingDate: Date | null;
  trainingLocation: string | null;
  title: string;
}): Promise<OnboardingPreviewContext> {
  const where = opts.departmentCodes === "all" ? { isActive: true } : { code: { in: opts.departmentCodes } };
  const [departments, allDepartments, orgName, zone] = await Promise.all([
    prisma.department.findMany({
      where,
      select: { code: true, name: true, requiresEpicDirector: true, requiresEpicVolunteer: true },
      orderBy: { name: "asc" },
    }),
    prisma.department.findMany({
      where: { isActive: true },
      select: { code: true },
      orderBy: { name: "asc" },
    }),
    getSetting<string>("branding.orgName"),
    getDisplayTimeZone(),
  ]);
  return {
    departments,
    allDepartmentCodes: allDepartments.map((d) => d.code),
    orgName,
    trainingDate: formatTrainingDate(opts.inPersonTrainingDate, zone),
    trainingLocation: formatTrainingLocation(opts.trainingLocation),
    todayIso: new Date().toISOString().slice(0, 10),
    title: opts.title,
    fixedTrack: opts.fixedTrack,
  };
}
