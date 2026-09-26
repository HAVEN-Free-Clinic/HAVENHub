import { z } from "zod";
import { getMyTraining } from "@/modules/recruitment/services/training";
import { getMyCourses } from "@/modules/learning/services/enrollment";
import type { McpTool } from "./index";
import { outstandingEhsClause } from "./ehs";
import { hubLink } from "./links";

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
    "The track training, learning courses, and EHS (Yale safety) trainings the signed-in member has not yet completed, with where to do each. Use for questions like 'what training do I still owe?', 'do I have any courses left?', 'have I finished my training?', or 'I did my BBP training, why is it not showing?'. Relay the links in the answer.",
  inputSchema: z.object({}),
  run: async (ctx) => {
    // getMyTraining spans every term the member belongs to; getMyCourses
    // defaults to the active term (its own termId param exists only for the
    // next-term checklist views, which this self-scoped tool has no use for).
    const [trainings, courses, ehs] = await Promise.all([
      getMyTraining(ctx.personId),
      getMyCourses(ctx.personId),
      // EHS was missing from this answer entirely, so "I did BBP, why is it not
      // showing" got "you have no outstanding training" -- true of the two
      // surfaces above and wrong about the one the member asked about. See
      // outstandingEhsClause for why a finished EHS item can still be listed.
      outstandingEhsClause(ctx.personId),
    ]);

    const outstandingTraining = trainings.filter((t) => t.state !== "COMPLETE");
    const outstandingCourses = courses.filter((c) => c.status !== "COMPLETE");

    if (outstandingTraining.length === 0 && outstandingCourses.length === 0 && !ehs) {
      return "You have no outstanding training, courses, or EHS trainings -- everything required is complete.";
    }

    const parts: string[] = [];
    if (outstandingTraining.length > 0) {
      // getMyTraining spans every term the member belongs to (see its own doc
      // comment), so the term name disambiguates a live-term item from an
      // already-published next-term one rather than presenting both as one.
      const names = outstandingTraining.map((t) => `${t.trackLabel} (${t.term.name})`);
      parts.push(`training: ${names.join(", ")} (Hub page: ${await hubLink("/training")})`);
    }
    if (outstandingCourses.length > 0) {
      const names = outstandingCourses.map((c) => c.title);
      parts.push(`courses: ${names.join(", ")} (Hub page: ${await hubLink("/learning")})`);
    }

    // EHS is its own sentence, not a third list item: it carries the
    // recording explanation, which reads as nonsense spliced mid-list.
    const sentences = parts.length > 0 ? [`You still owe ${parts.join(" and ")}.`] : [];
    if (ehs) sentences.push(ehs);
    return sentences.join(" ");
  },
};
