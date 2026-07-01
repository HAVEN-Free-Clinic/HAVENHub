/** Pure applicability resolution for EHS trainings. No DB. A training is required
 *  for a member when it is active and either requiredForAll or one of the member's
 *  departments is in the training's department list. Mirrors the Learning module's
 *  coursesForMember, minus the SCORM package and audience-by-kind logic. */

export type RequirableTraining = {
  id: string;
  name: string;
  isActive: boolean;
  requiredForAll: boolean;
  departmentIds: string[];
};

/** Yale-school affiliates are students; Yale Staff, Other Yale Affiliation, and
 *  blank/unknown are non-students (per the configured mapping). */
const NON_STUDENT_AFFILIATIONS = new Set(["Yale Staff", "Other Yale Affiliation"]);

export function isStudentAffiliation(yaleAffiliation: string | null | undefined): boolean {
  const a = (yaleAffiliation ?? "").trim();
  return a !== "" && !NON_STUDENT_AFFILIATIONS.has(a);
}

/** BBP split is hardcoded on the stable seed ids: clinical BBP is for non-students,
 *  student BBP is for students. Applied AFTER the department/requiredForAll check. */
const BBP_CLINICAL_ID = "ehs_bbp_clinical";
const BBP_STUDENT_ID = "ehs_bbp_student";

export function requiredTrainingsForMember(params: {
  trainings: RequirableTraining[];
  memberDepartmentIds: string[];
  isStudent: boolean;
}): RequirableTraining[] {
  const memberDepts = new Set(params.memberDepartmentIds);
  return params.trainings.filter((training) => {
    if (
      !training.isActive ||
      (!training.requiredForAll && !training.departmentIds.some((d) => memberDepts.has(d)))
    )
      return false;
    // BBP student/clinical split: applied after the department/requiredForAll check.
    if (training.id === BBP_CLINICAL_ID && params.isStudent) return false; // clinical BBP: non-students only
    if (training.id === BBP_STUDENT_ID && !params.isStudent) return false; // student BBP: students only
    return true;
  });
}

/** A person is fully compliant only when HIPAA is COMPLIANT and no required EHS item is missing. */
export function isFullyCompliant(params: {
  hipaaStatus: string;
  ehsMissingCount: number;
}): boolean {
  return params.hipaaStatus === "COMPLIANT" && params.ehsMissingCount === 0;
}

export function missingTrainings(params: {
  trainings: RequirableTraining[];
  memberDepartmentIds: string[];
  completedTrainingIds: Iterable<string>;
  isStudent: boolean;
}): { id: string; name: string }[] {
  const completed = new Set(params.completedTrainingIds);
  return requiredTrainingsForMember({
    trainings: params.trainings,
    memberDepartmentIds: params.memberDepartmentIds,
    isStudent: params.isStudent,
  })
    .filter((training) => !completed.has(training.id))
    .map((training) => ({ id: training.id, name: training.name }));
}
