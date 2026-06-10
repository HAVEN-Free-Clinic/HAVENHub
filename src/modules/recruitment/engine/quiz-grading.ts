/** Re-export of the shared grader. The implementation moved to
 *  @/platform/quiz/grading so non-recruitment modules can use it without
 *  reaching into recruitment internals. */
export { gradeQuiz } from "@/platform/quiz/grading";
export type { GradedQuestion, QuizResult } from "@/platform/quiz/grading";
