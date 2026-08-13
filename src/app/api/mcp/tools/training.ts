import { z } from "zod";
import { getMyTraining } from "@/modules/recruitment/services/training";
import { getMyCourses } from "@/modules/learning/services/enrollment";
import type { McpTool } from "./index";

/**
 * "What training do I still owe?" -- the natural follow-up once a member learns
 * they are not cleared (see myClearanceStatusTool), and also asked on its own.
 *
 * The app tracks two independent training surfaces, each owned by a different
 * module with its own completion state: recruitment "track training" (the
 * volunteer/director onboarding quiz, surfaced at /training) and learning
 * "courses" (SCORM modules assigned per department, surfaced at /learning).
 * A member asking what they still owe means both, so both are queried and
 * merged into one answer here rather than making Fin guess which one to ask
 * about. Reuses getMyTraining and getMyCourses -- the exact services those
 * pages read -- rather than re-deriving completion from Training/CourseProgress
 * rows directly, so this answer can never disagree with what the member sees
 * on either page.
 */
export const myOutstandingTrainingTool: McpTool = {
  name: "my_outstanding_training",
  title: "My outstanding training",
  description:
    "The track training and learning courses the signed-in member has not yet completed. Use for questions like 'what training do I still owe?', 'do I have any courses left?', or 'have I finished my training?'.",
  inputSchema: z.object({}),
  run: async (ctx) => {
    // getMyTraining spans every term the member belongs to; getMyCourses
    // defaults to the active term (its own termId param exists only for the
    // next-term checklist views, which this self-scoped tool has no use for).
    const [trainings, courses] = await Promise.all([
      getMyTraining(ctx.personId),
      getMyCourses(ctx.personId),
    ]);

    const outstandingTraining = trainings.filter((t) => t.state !== "COMPLETE");
    const outstandingCourses = courses.filter((c) => c.status !== "COMPLETE");

    if (outstandingTraining.length === 0 && outstandingCourses.length === 0) {
      return "You have no outstanding training or courses -- everything required is complete.";
    }

    const parts: string[] = [];
    if (outstandingTraining.length > 0) {
      // getMyTraining spans every term the member belongs to (see its own doc
      // comment), so the term name disambiguates a live-term item from an
      // already-published next-term one rather than presenting both as one.
      const names = outstandingTraining.map((t) => `${t.trackLabel} (${t.term.name})`);
      parts.push(`training: ${names.join(", ")}`);
    }
    if (outstandingCourses.length > 0) {
      const names = outstandingCourses.map((c) => c.title);
      parts.push(`courses: ${names.join(", ")}`);
    }

    return `You still owe ${parts.join(" and ")}.`;
  },
};
