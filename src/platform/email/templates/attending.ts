import type { TemplateDescriptor } from "./types";

/**
 * Weekly attending reminder. Sent Monday mornings to the attendings covering the
 * upcoming clinic day (see src/platform/email/attending-reminders.ts).
 *
 * Registered here so the Faculty Relations director can edit the wording in
 * /admin/email/templates without a deploy, which is the point: the letter is
 * theirs, and it changed several times before it lived in the Hub.
 *
 * `scheduleTable` is rendered raw ({{{ }}}) because its builder emits the
 * slot-by-slot lines as HTML. Every name inside it is escaped where it is built.
 * `onCallAttending` is guarded with {{#if}} so a week with nobody on call hides
 * the line rather than printing a dangling label.
 */

export type AttendingReminderParams = {
  /** e.g. "Saturday, August 15th". */
  clinicDateLabel: string;
  /** Pre-rendered HTML, one line per staffed slot (raw). */
  scheduleTable: string;
  /** Name of the attending holding the on-call week, or "" when unset. */
  onCallAttending: string;
  /** Who signs off, from the Faculty Relations setting. */
  signOffName: string;
  clinicAddress: string;
  /** Where an attending reports a scheduling change. */
  contactEmail: string;
};

export function attendingReminderContext(p: AttendingReminderParams): Record<string, unknown> {
  return { ...p };
}

const DEFAULT_BODY = `<p>Dear HAVEN attendings,</p>
<p>This is a friendly reminder of your scheduled shift at HAVEN Free Clinic this {{ clinicDateLabel }}.</p>
<p>Please arrive on time and let us know if you have any scheduling changes. Your support is essential in providing quality care to our patients, and we truly appreciate your time and dedication.</p>
<p>Below is the schedule for this {{ clinicDateLabel }}:</p>
{{{ scheduleTable }}}
{{#if onCallAttending}}<p><strong>On-Call Attending</strong> (for the week leading up to the NEXT clinic day): {{ onCallAttending }}</p>{{/if}}
<p>Thank you, and we look forward to seeing you!</p>
<p>Best,<br/>{{ signOffName }}</p>`;

export const attendingDescriptors: TemplateDescriptor[] = [
  {
    key: "attending-reminder",
    name: "Attendings: weekly reminder",
    category: "transactional",
    group: "shift",
    variables: [
      { name: "clinicDateLabel", label: "Clinic date", sampleValue: "Saturday, August 15th" },
      {
        name: "scheduleTable",
        label: "Slot-by-slot schedule (HTML)",
        sampleValue:
          "<p><strong>9am-12pm</strong>: Dr. Frank Bia, Dr. Peggy Bia<br/><strong>11am-2pm</strong>: Dr. Jack Peng</p>",
      },
      { name: "onCallAttending", label: "On-call attending for the coming week", sampleValue: "Dr. Peggy Bia" },
      { name: "signOffName", label: "Who the email signs off as", sampleValue: "Haley Zhang" },
      {
        name: "clinicAddress",
        label: "Clinic address",
        sampleValue: "800 Howard Ave, New Haven, CT (Yale Physicians Building)",
      },
      { name: "contactEmail", label: "Where to reply about scheduling", sampleValue: "hfc.it@yale.edu" },
    ],
    defaultSubject: "Upcoming HAVEN Free Clinic Shift Reminder",
    defaultBody: DEFAULT_BODY,
  },
];
