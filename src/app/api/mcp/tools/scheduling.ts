import { z } from "zod";
import { mySchedule } from "@/modules/schedule/services/schedule";
import { formatCalendarDate } from "@/platform/dates";
import type { McpTool } from "./index";

/**
 * "When is my next shift?", the highest-volume and lowest-sensitivity support
 * question there is.
 *
 * Takes no input on purpose. The caller is already known from the verified
 * Intercom contact, and adding even a date filter would hand the model a lever
 * over what gets read. The answer is a sentence, not a row: tool output can be
 * rendered straight into the chat and shared with the member.
 */
export const myNextShiftTool: McpTool = {
  name: "my_next_shift",
  title: "My next shift",
  description:
    "The signed-in member's next upcoming clinic shift, with the date and department. Use for questions like 'when is my next shift?' or 'am I on this week?'.",
  inputSchema: z.object({}),
  run: async (ctx) => {
    const { terms } = await mySchedule(ctx.personId);
    const live = terms.find((t) => t.isLive);
    if (!live) return "You have no upcoming shifts scheduled.";

    const now = new Date();
    const upcoming = live.shifts
      .filter((s) => s.clinicDate >= now)
      .sort((a, b) => a.clinicDate.getTime() - b.clinicDate.getTime());

    const next = upcoming[0];
    if (!next) return "You have no upcoming shifts scheduled.";

    // formatCalendarDate, NOT formatDateOnly. clinicDate is a date-only value
    // stored at UTC midnight, and formatCalendarDate renders calendar days in
    // UTC for exactly that reason. Passing it through a zoned formatter with
    // America/New_York would render UTC midnight as 8pm the previous evening
    // and report the wrong day, which on a shift reminder is the whole answer
    // being wrong.
    return `Your next shift is on ${formatCalendarDate(next.clinicDate)} with ${next.department.name}.`;
  },
};
