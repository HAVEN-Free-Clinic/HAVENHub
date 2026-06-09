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
