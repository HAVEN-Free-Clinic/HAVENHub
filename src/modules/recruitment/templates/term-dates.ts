import type { TemplateOption } from "./types";

/** Every Saturday in [start, end], value = YYYY-MM-DD, label = "Mon D". */
export function termSaturdays(start: Date, end: Date): TemplateOption[] {
  const out: TemplateOption[] = [];
  const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  while (d.getUTCDay() !== 6) d.setUTCDate(d.getUTCDate() + 1);
  const fmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  for (; d <= end; d.setUTCDate(d.getUTCDate() + 7)) {
    out.push({ value: d.toISOString().slice(0, 10), label: fmt.format(d) });
  }
  return out;
}
