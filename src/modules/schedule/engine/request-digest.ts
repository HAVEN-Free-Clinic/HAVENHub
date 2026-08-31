/**
 * The Executive Directors' daily roll-up of shift requests still awaiting a
 * decision.
 *
 * The per-approver reminder (see request-reminder-cadence.ts) is addressed to
 * the people who can actually decide a request, and the cron takes at most ONE
 * dispatch claim per person per day. That cap is right for a department
 * director, who owns one department: whichever request is most pressing is the
 * one they hear about. It is wrong for an Executive Director, who is watching
 * every department at once and would otherwise learn about exactly one stalled
 * request per day and never hear about the rest.
 *
 * So the EDs get a digest instead of a copy: one email listing everything that
 * has reached the escalation bar, grouped by department.
 *
 * That bar (belongsInDigest) is NOT the approver reminder's cadence. It is the
 * two things an ED actually needs to know about, and nothing else:
 *
 *   - the clinic date is inside the coming week, at any age. There is no later
 *     approval slot, so a drop filed this morning for this Saturday belongs in
 *     tomorrow's digest even though its department has barely had a chance to
 *     act on it.
 *   - or the request has gone untouched for DIGEST_STALE_DAYS. By then the
 *     department has had its own reminder and two further days on top of it,
 *     and the request is no longer merely open, it is stuck.
 *
 * Pure: no clock, no I/O. Dates arrive pre-formatted and ages pre-measured, so
 * the caller owns the display zone.
 */
import { esc } from "@/platform/email/render/escape";
import { URGENT_WINDOW_DAYS, type ReminderUrgency } from "./request-reminder-cadence";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long a request with no clinic-week pressure may sit before the Executive
 * Directors hear about it.
 *
 * Deliberately longer than the NORMAL reminder cadence's 48 hours: escalating
 * the moment the department's own first reminder goes out would make the digest
 * a duplicate of that reminder rather than a signal that it went unheeded.
 */
export const DIGEST_STALE_DAYS = 4;

/**
 * Has this pending request earned a place in the Executive Directors' digest?
 *
 * Note there is no minimum age on the clinic-week lane, on purpose: a shift
 * being given up days before the clinic is the case where waiting to escalate
 * costs the coverage.
 */
export function belongsInDigest(input: { urgency: ReminderUrgency; ageMs: number }): boolean {
  if (input.urgency === "URGENT") return true;
  return input.ageMs >= DIGEST_STALE_DAYS * DAY_MS;
}

export type DigestEntry = {
  departmentId: string;
  departmentName: string;
  requesterName: string;
  /** Already formatted for display, e.g. "September 6, 2026". */
  requesterDate: string;
  /** The other half of a swap, or null when the request is a drop. */
  partner: { name: string; date: string } | null;
  urgency: ReminderUrgency;
  /** How long the request has been pending, in milliseconds. */
  ageMs: number;
};

export type RequestDigest = {
  /** "7 shift requests" / "1 shift request", for the subject line. */
  pendingSummary: string;
  /** Pre-rendered HTML, one block per department. Every value inside is escaped. */
  requestList: string;
};

function pendingFor(ageMs: number): string {
  const days = Math.floor(ageMs / DAY_MS);
  if (days < 1) return "pending less than a day";
  return days === 1 ? "pending 1 day" : `pending ${days} days`;
}

function lineFor(entry: DigestEntry): string {
  const kind = entry.partner ? "Swap" : "Drop";
  const who = `${esc(entry.requesterName)} (${esc(entry.requesterDate)})`;
  const partnerPart = entry.partner
    ? ` with ${esc(entry.partner.name)} (${esc(entry.partner.date)})`
    : "";
  // The clinic date being inside the urgent window is the whole reason an ED
  // would act on a line rather than read it: after that Saturday there is no
  // approval left to give.
  const urgent =
    entry.urgency === "URGENT"
      ? ` <strong>(clinic within ${URGENT_WINDOW_DAYS} days)</strong>`
      : "";
  return `${kind}: ${who}${partnerPart}, ${pendingFor(entry.ageMs)}${urgent}`;
}

/**
 * Group `entries` by department and render them as email HTML.
 *
 * Departments appear in the order their first entry does, which -- because the
 * caller sorts by urgency then clinic date -- puts the department with the most
 * pressing request at the top. Grouping keys on departmentId, not the display
 * name, so two departments that happen to share a name stay separate blocks.
 *
 * An empty list returns empty strings; the caller sends nothing at all rather
 * than an email announcing that there is nothing to report.
 */
export function buildRequestDigest(entries: DigestEntry[]): RequestDigest {
  if (entries.length === 0) return { pendingSummary: "", requestList: "" };

  const order: string[] = [];
  const byDepartment = new Map<string, { name: string; lines: string[] }>();
  for (const entry of entries) {
    let group = byDepartment.get(entry.departmentId);
    if (!group) {
      group = { name: entry.departmentName, lines: [] };
      byDepartment.set(entry.departmentId, group);
      order.push(entry.departmentId);
    }
    group.lines.push(lineFor(entry));
  }

  const blocks = order.map((id) => {
    const group = byDepartment.get(id)!;
    return `<p><strong>${esc(group.name)}</strong><br/>${group.lines.join("<br/>")}</p>`;
  });

  const n = entries.length;
  return {
    pendingSummary: `${n} shift request${n === 1 ? "" : "s"}`,
    requestList: blocks.join("\n"),
  };
}
