/** How many quiz questions carry an answer key. A quiz with zero can never be
 *  passed (`gradeQuiz` returns passed = false when total is 0), so this is the
 *  single definition of "ready to grade" shared by the designation guard, the
 *  submit guard, and the learner-facing render. Structural parameter type so
 *  every caller can pass its own row shape without a mapping step. */
export function countGradedQuestions(questions: { correctValue: string | null }[]): number {
  return questions.filter((q) => q.correctValue !== null).length;
}
