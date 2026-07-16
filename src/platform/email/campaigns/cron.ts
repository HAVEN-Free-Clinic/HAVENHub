import { CronExpressionParser } from "cron-parser";

export function isValidCron(expr: string): boolean {
  if (!expr || expr.trim() === "") return false;
  try {
    CronExpressionParser.parse(expr, { tz: "UTC" });
    return true;
  } catch {
    return false;
  }
}

/** Next occurrence strictly after `after`, interpreted in UTC. Throws on a bad expression. */
export function nextCronAfter(expr: string, after: Date): Date {
  const it = CronExpressionParser.parse(expr, { currentDate: after, tz: "UTC" });
  return it.next().toDate();
}

/**
 * Campaign dispatch runs on this cadence (see /api/cron/email). A recurring
 * schedule finer than this silently skips the occurrences between dispatch ticks
 * (dispatch advances nextRunAt to the next occurrence strictly after "now").
 */
export const CAMPAIGN_DISPATCH_CADENCE_MINUTES = 30;

/**
 * Smallest gap in minutes between consecutive occurrences over the next `samples`
 * from `after`. Used to reject a cadence finer than the dispatcher can honor.
 * Throws on a bad expression.
 */
export function cronMinIntervalMinutes(expr: string, after: Date, samples = 60): number {
  const it = CronExpressionParser.parse(expr, { currentDate: after, tz: "UTC" });
  let prev = it.next().toDate().getTime();
  let min = Infinity;
  for (let i = 0; i < samples; i++) {
    const next = it.next().toDate().getTime();
    min = Math.min(min, (next - prev) / 60000);
    prev = next;
  }
  return min;
}
