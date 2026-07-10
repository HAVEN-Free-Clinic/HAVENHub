/** Pure quiz grader. No DB, no side effects. A question with correctValue == null
 *  is non-graded (excluded from the total). A quiz with no graded questions can
 *  never pass, so an unfinished quiz never clears a volunteer. */

export type GradedQuestion = { key: string; correctValue: string | null };

export type QuizResult = {
  score: number;
  total: number;
  percent: number;
  passed: boolean;
};

export function gradeQuiz(
  questions: GradedQuestion[],
  answers: Record<string, unknown>,
  passPercent: number
): QuizResult {
  const graded = questions.filter((q) => q.correctValue !== null);
  const total = graded.length;
  let score = 0;
  for (const q of graded) {
    if (answers[q.key] === q.correctValue) score += 1;
  }
  const rawPercent = total === 0 ? 0 : (100 * score) / total;
  // Round for display only; pass/fail compares the raw percentage so a
  // below-threshold score (e.g. 69.5) can't round up (to 70) and clear the gate.
  const percent = Math.round(rawPercent);
  const passed = total > 0 && rawPercent >= passPercent;
  return { score, total, percent, passed };
}
