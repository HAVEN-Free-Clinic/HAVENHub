import { z } from "zod";
import { mySchedule } from "@/modules/schedule/services/schedule";
import { formatCalendarDate, isoDateKey } from "@/platform/dates";
import { displayTodayKey } from "@/platform/dates/today";
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

    const now = new Date();
    // clinicDate is stored at UTC midnight, so comparing it against a raw
    // wall-clock `now` (Date >= Date) misreads a shift as already "past" from
    // roughly 8pm ET the evening before, straight through the entire day it
    // actually happens -- exactly the window when a member is most likely to
    // ask this. Compare by day key instead, anchored to the display-zone (ET)
    // calendar day, the same fix fullSchedule and displayTodayKey both carry.
    const todayKey = await displayTodayKey(now);

    // Every term mySchedule returns is a real candidate, not just the live
    // one: a member's next-term shifts are already visible once their
    // department publishes, ahead of the live/next flip (see mySchedule's own
    // doc comment). Restricting to the live term would wrongly report
    // "nothing upcoming" for someone whose live-term shifts are exhausted but
    // who already has a published next-term shift.
    const upcoming = terms
      .flatMap((t) => t.shifts)
      .filter((s) => isoDateKey(s.clinicDate) >= todayKey)
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
