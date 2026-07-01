/** Pure applicability resolution for EHS trainings. No DB. Every active training
 *  applies to every person -- no department scoping, no requiredForAll flag. */

export type EhsTrainingLite = { id: string; name: string; isActive: boolean };

/** Active trainings the person has not completed. Every active training applies to everyone. */
export function missingTrainings(params: {
  trainings: EhsTrainingLite[];
  completedTrainingIds: Iterable<string>;
}): { id: string; name: string }[] {
  const completed = new Set(params.completedTrainingIds);
  return params.trainings
    .filter((t) => t.isActive && !completed.has(t.id))
    .map((t) => ({ id: t.id, name: t.name }));
}

/** A person is fully compliant only when HIPAA is COMPLIANT and no required EHS item is missing. */
export function isFullyCompliant(params: {
  hipaaStatus: string;
  ehsMissingCount: number;
}): boolean {
  return params.hipaaStatus === "COMPLIANT" && params.ehsMissingCount === 0;
}
