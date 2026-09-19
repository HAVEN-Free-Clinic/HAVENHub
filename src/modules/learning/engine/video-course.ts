/** Pure rules for a VIDEO course's sections. No DB. */

export type SectionProgressFacts = { watchedAt: Date | null; passedAt: Date | null };

export type SectionState = {
  id: string;
  /** Every earlier section has been passed. */
  unlocked: boolean;
  watched: boolean;
  passed: boolean;
  /** The quiz can be taken now: unlocked, watched, not yet passed. */
  quizOpen: boolean;
};

/**
 * Where a learner stands on each section, in position order. A section opens
 * once every section before it is passed, and its quiz once its video has been
 * watched to the end. A later section's own progress never opens it early:
 * order is the rule, not whatever rows happen to exist.
 */
export function sectionStates(
  sections: { id: string }[],
  progress: Map<string, SectionProgressFacts>
): SectionState[] {
  let allPriorPassed = true;
  return sections.map((section) => {
    const p = progress.get(section.id);
    const unlocked = allPriorPassed;
    const watched = unlocked && p?.watchedAt != null;
    const passed = unlocked && p?.passedAt != null;
    allPriorPassed = allPriorPassed && passed;
    return { id: section.id, unlocked, watched, passed, quizOpen: unlocked && watched && !passed };
  });
}

/**
 * Whether a VIDEO course can be completed at all: at least one section, and
 * every section has a video, a knowable length, and a keyed question. A course
 * that fails this is a draft assigned to no one, for the same reason a SCORM
 * course with no package is: requiring something nobody can finish locks every
 * assigned member out of the onboarding gate.
 */
export function videoCourseReady(
  sections: { hasVideo: boolean; length: number | null; gradedQuestionCount: number }[]
): boolean {
  return (
    sections.length > 0 &&
    sections.every((s) => s.hasVideo && s.length != null && s.length > 0 && s.gradedQuestionCount > 0)
  );
}

/** Attempts that count toward the lock: those taken at or after the last reset. */
export function attemptsInWindow(attempts: { takenAt: Date }[], lockResetAt: Date | null): number {
  if (!lockResetAt) return attempts.length;
  return attempts.filter((a) => a.takenAt.getTime() >= lockResetAt.getTime()).length;
}
