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
  {
    key: "attending-hub-access",
    name: "Attendings: Hub access enabled",
    category: "transactional",
    group: "shift",
    variables: [
      { name: "scheduleUrl", label: "Hub schedule link", sampleValue: "https://hub.havenfreeclinic.org/schedule" },
      { name: "loginUrl", label: "Hub sign-in link", sampleValue: "https://hub.havenfreeclinic.org/login" },
      { name: "attendingName", label: "Attending name", sampleValue: "Dr. Peggy Bia" },
      // Yale faculty sign in with their Yale account; everyone else gets an
      // emailed link. Which sentence applies is decided where the email is sent
      // (enableHubAccess knows the address), not by the reader.
      { name: "signInHint", label: "How this person signs in", sampleValue: "Sign in with your Yale NetID." },
    ],
    defaultSubject: "Your HAVEN Free Clinic schedule is now online",
    defaultBody: `<p>Dear {{ attendingName }},</p>
<p>You can now see your HAVEN Free Clinic schedule in HAVEN Hub, tell us which clinic dates you are able to cover, and request a swap or drop a date without emailing anyone.</p>
<p>{{ signInHint }}</p>
<p><a href="{{ scheduleUrl }}">Open your schedule</a></p>
<p>You will still get the weekly reminder email before each clinic day. Nothing about how you are scheduled has changed.</p>`,
  },
  {
    key: "attending-request-submitted",
    name: "Attendings: swap/drop request submitted (Faculty Relations)",
    category: "transactional",
    group: "shift",
    variables: [
      { name: "scheduleUrl", label: "Hub schedule link", sampleValue: "https://hub.havenfreeclinic.org/schedule" },
      { name: "requestsUrl", label: "Hub approvals link", sampleValue: "https://hub.havenfreeclinic.org/schedule/requests" },
      { name: "recipientName", label: "Recipient first name", sampleValue: "Haley" },
      { name: "requesterName", label: "Attending making the request", sampleValue: "Dr. Peggy Bia" },
      { name: "requestType", label: "Request type (swap or drop)", sampleValue: "swap" },
      { name: "requesterDate", label: "Date they are giving up", sampleValue: "July 15, 2026" },
      { name: "slotLabel", label: "Schedule column", sampleValue: "9am-12pm" },
      { name: "partnerName", label: "Swap partner (swap only)", sampleValue: "Dr. Frank Bia" },
      { name: "partnerDate", label: "Partner's date (swap only)", sampleValue: "July 22, 2026" },
      { name: "note", label: "Their note, if any", sampleValue: "Away at a conference that weekend." },
    ],
    defaultSubject: "Attending {{ requestType }} request: {{ requesterName }}",
    defaultBody: `<p>Hi {{ recipientName }},</p>
<p><strong>{{ requesterName }}</strong> has requested a <strong>{{ requestType }}</strong> for the <strong>{{ slotLabel }}</strong> column on <strong>{{ requesterDate }}</strong>.</p>
{{#if partnerName}}<p>They have asked to trade with <strong>{{ partnerName }}</strong> ({{ partnerDate }}).</p>{{/if}}
{{#if note}}<p><em>{{ note }}</em></p>{{/if}}
<p>Nothing has changed on the schedule yet. The request applies only once you approve it.</p>
{{#if requestsUrl}}<p><a href="{{ requestsUrl }}">Review pending requests</a></p>{{/if}}`,
  },
  {
    key: "attending-request-approved",
    name: "Attendings: swap/drop request approved",
    category: "transactional",
    group: "shift",
    variables: [
      { name: "scheduleUrl", label: "Hub schedule link", sampleValue: "https://hub.havenfreeclinic.org/schedule" },
      { name: "requestsUrl", label: "Hub approvals link", sampleValue: "https://hub.havenfreeclinic.org/schedule/requests" },
      { name: "recipientName", label: "Recipient name", sampleValue: "Dr. Peggy Bia" },
      { name: "requestType", label: "Request type (swap or drop)", sampleValue: "swap" },
      { name: "requesterDate", label: "Date given up", sampleValue: "July 15, 2026" },
      { name: "slotLabel", label: "Schedule column", sampleValue: "9am-12pm" },
      { name: "otherName", label: "The other attending (swap only)", sampleValue: "Dr. Frank Bia" },
      { name: "partnerDate", label: "The other date (swap only)", sampleValue: "July 22, 2026" },
    ],
    defaultSubject: "Your {{ requestType }} request has been approved",
    defaultBody: `<p>Dear {{ recipientName }},</p>
<p>Your <strong>{{ requestType }} request</strong> for the <strong>{{ slotLabel }}</strong> column on <strong>{{ requesterDate }}</strong> has been <strong>approved</strong> by Faculty Relations.</p>
{{#if otherName}}<p>You and <strong>{{ otherName }}</strong> have traded dates: {{ partnerDate }} is now yours.</p>{{/if}}
<p>The schedule has been updated.</p>
<p><a href="{{ scheduleUrl }}">View your schedule</a></p>`,
  },
  {
    key: "attending-request-denied",
    name: "Attendings: swap/drop request denied",
    category: "transactional",
    group: "shift",
    variables: [
      { name: "scheduleUrl", label: "Hub schedule link", sampleValue: "https://hub.havenfreeclinic.org/schedule" },
      { name: "requestsUrl", label: "Hub approvals link", sampleValue: "https://hub.havenfreeclinic.org/schedule/requests" },
      { name: "recipientName", label: "Recipient name", sampleValue: "Dr. Peggy Bia" },
      { name: "requestType", label: "Request type (swap or drop)", sampleValue: "swap" },
      { name: "requesterDate", label: "Date requested", sampleValue: "July 15, 2026" },
      { name: "slotLabel", label: "Schedule column", sampleValue: "9am-12pm" },
      { name: "otherName", label: "The other attending (swap only)", sampleValue: "Dr. Frank Bia" },
      { name: "partnerDate", label: "The other date (swap only)", sampleValue: "July 22, 2026" },
    ],
    defaultSubject: "Your {{ requestType }} request was not approved",
    defaultBody: `<p>Dear {{ recipientName }},</p>
<p>Your <strong>{{ requestType }} request</strong> for the <strong>{{ slotLabel }}</strong> column on <strong>{{ requesterDate }}</strong> was <strong>not approved</strong>.</p>
<p>The schedule is unchanged, so you are still covering that date. Please reply to this email if you need to discuss it.</p>
<p><a href="{{ scheduleUrl }}">View your schedule</a></p>`,
  },
];
