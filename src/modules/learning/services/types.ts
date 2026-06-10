/** One quiz question as stored in CourseModule.questions (JSON). The grader
 *  consumes only { key, correctValue }; label/options are for rendering. A null
 *  correctValue marks a non-graded question. */
export type QuizQuestion = {
  key: string;
  label: string;
  options: { value: string; label: string }[];
  correctValue: string | null;
};

/** Parse the JSON column into typed questions; returns [] for null/invalid. */
export function parseQuizQuestions(value: unknown): QuizQuestion[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (q): q is QuizQuestion =>
      !!q &&
      typeof q === "object" &&
      typeof (q as QuizQuestion).key === "string" &&
      typeof (q as QuizQuestion).label === "string" &&
      Array.isArray((q as QuizQuestion).options)
  );
}
