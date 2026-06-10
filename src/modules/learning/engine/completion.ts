import type { CourseModuleKind } from "@prisma/client";

/** The state of one module for one learner. For VIDEO/DOCUMENT, `completed`
 *  drives doneness; for QUIZ, `quizPassed` does. */
export type ModuleState = {
  kind: CourseModuleKind;
  completed: boolean;
  quizPassed: boolean;
};

function isModuleDone(m: ModuleState): boolean {
  return m.kind === "QUIZ" ? m.quizPassed : m.completed;
}

/** A course is complete when it has at least one module and every module is done. */
export function isCourseComplete(modules: ModuleState[]): boolean {
  return modules.length > 0 && modules.every(isModuleDone);
}

/** Done vs total module counts, for the learner's progress label. */
export function progressCounts(modules: ModuleState[]): { done: number; total: number } {
  return { done: modules.filter(isModuleDone).length, total: modules.length };
}
