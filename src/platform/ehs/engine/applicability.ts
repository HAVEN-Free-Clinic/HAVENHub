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

export function requiredTrainingsForMember(params: {
  trainings: RequirableTraining[];
  memberDepartmentIds: string[];
}): RequirableTraining[] {
  const memberDepts = new Set(params.memberDepartmentIds);
  return params.trainings.filter(
    (training) =>
      training.isActive &&
      (training.requiredForAll ||
        training.departmentIds.some((d) => memberDepts.has(d)))
  );
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
}): { id: string; name: string }[] {
  const completed = new Set(params.completedTrainingIds);
  return requiredTrainingsForMember({
    trainings: params.trainings,
    memberDepartmentIds: params.memberDepartmentIds,
  })
    .filter((training) => !completed.has(training.id))
    .map((training) => ({ id: training.id, name: training.name }));
}
