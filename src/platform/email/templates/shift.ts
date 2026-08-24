import type { TemplateDescriptor } from "./types";

/**
 * Weekly shift-reminder email. Sent Monday mornings to everyone scheduled for
 * the upcoming Saturday clinic day (see src/platform/email/shift-reminders.ts).
 * Registered here so admins can edit the global default in /admin/email/templates.
 *
 * additionalShifts is rendered raw ({{{ }}}) because its builder emits either an
 * HTML paragraph or an empty string. The on-shift name lists (edsOnShift,
 * deptDirectorsOnShift, clinicalAdvisorsOnShift) and teamsChannelUrl are guarded
 * with {{#if}} so an empty value hides its section. Static links (Epic help desk,
 * Resource Guide) and the shift time and location live inline in the body so an
 * admin can edit them without a deploy. All other values use escaped {{ }}.
 */

export type ShiftReminderParams = {
  firstName: string;
  roleLabel: string;
  departmentName: string;
  clinicDateLabel: string;
  /** Pre-rendered HTML for extra same-day shifts, or "" (raw). */
  additionalShifts: string;
  edsOnShift: string;
  deptDirectorsOnShift: string;
  clinicalAdvisorsOnShift: string;
  /** Attending physician on duty for this clinic date, or "" when none is set. */
  attendingOnShift: string;
  teamsChannelUrl: string;
  hipaaComplianceUrl: string;
  /** Hub IT ticketing, for Epic access problems. */
  helpDeskUrl: string;
  shiftSwapUrl: string;
  masterScheduleUrl: string;
};

export function shiftReminderContext(p: ShiftReminderParams): Record<string, unknown> {
  return { ...p };
}

const DEFAULT_BODY = `<p>Hello {{ firstName }},</p>
<p>This is a friendly reminder that you are scheduled for a <strong>{{ roleLabel }}</strong> Shift in the <strong>{{ departmentName }}</strong> department at HAVEN Free Clinic this {{ clinicDateLabel }}.</p>
{{{ additionalShifts }}}
<h2>Shift Details</h2>
<p><strong>Date:</strong> {{ clinicDateLabel }}<br/>
<strong>Time:</strong> 8:00 AM to 2:00 PM<br/>
<strong>Location:</strong> Yale Physicians Building, 800 Howard Avenue, Floor 1, New Haven, CT 06519 (there is free parking on Saturdays)</p>
<h2>Before Your Shift</h2>
<ul>
<li>Please verify your Epic access by Wednesday before your shift. If you are experiencing issues, submit a Help Desk ticket <a href="{{ helpDeskUrl }}">here</a> as soon as possible. We are unable to accommodate Epic-related requests submitted after Wednesday, so please plan ahead.</li>
<li>Review the HAVEN Resource Guide <a href="https://yaleedu.sharepoint.com/:w:/s/HAVENFreeClinic/IQD9rSYTQa15QYspDXCXzDqEAaf9R-gN8Yr43oy6sxuLK5o?e=1Qk44n">here</a>.</li>
<li>Confirm your HIPAA and compliance requirements are up to date <a href="{{ hipaaComplianceUrl }}">here</a>.</li>
</ul>
<h2>Attendance &amp; Scheduling</h2>
<ul>
<li>If you cannot attend, request coverage as soon as possible.</li>
<li>Shift swaps must be arranged in advance and submitted <a href="{{ shiftSwapUrl }}">here</a>.</li>
<li>Absences are only excused in emergency situations and are reviewed on a case-by-case basis.</li>
<li>Unexcused absences may result in a strike under HAVEN policy.</li>
</ul>
<h2>During Your Shift</h2>
<ul>
<li><strong>Attendance at Morning Meeting is required for all volunteers.</strong> Clinical team members should join by <strong>7:50 AM</strong>, while all other volunteers should join by <strong>8:00 AM</strong>.{{#if teamsChannelUrl}} The Zoom link can be found in this week's Teams channel <a href="{{ teamsChannelUrl }}">here</a>.{{/if}}</li>
<li>Arrive on time and dress professionally (closed-toe shoes required; no jeans).</li>
<li>Maintain professionalism with patients, volunteers, faculty, and staff at all times.</li>
</ul>
<h2>Questions?</h2>
<p>For urgent clinic-day concerns, please contact {{#if edsOnShift}}the Executive Director(s) on shift, <strong>{{ edsOnShift }}</strong>{{#if deptDirectorsOnShift}}, or your department director(s) on shift, <strong>{{ deptDirectorsOnShift }}</strong>{{/if}}{{else}}{{#if deptDirectorsOnShift}}your department director(s) on shift, <strong>{{ deptDirectorsOnShift }}</strong>{{else}}the HAVEN leadership team{{/if}}{{/if}}.</p>
{{#if clinicalAdvisorsOnShift}}<p>Clinical Advisor(s) on shift: <strong>{{ clinicalAdvisorsOnShift }}</strong></p>{{/if}}
{{#if attendingOnShift}}<p>Attending on shift: <strong>{{ attendingOnShift }}</strong></p>{{/if}}
<p>The master schedule can be found <a href="{{ masterScheduleUrl }}">here</a>.</p>
<p>Thank you for your commitment to our patients and to HAVEN. We look forward to seeing you on Saturday!</p>`;

/**
 * Supplemental role reminders, sent alongside the weekly shift reminder to the
 * one or two people holding a special med-team post that clinic day.
 *
 * These are separate emails rather than sections of the main reminder because
 * ops writes them in their own voice, with their own greeting and sign-off, and
 * wants to be able to turn either off without touching the reminder everybody
 * gets. Recipients are derived from the ShiftAssignment tags (JCTP + cc, SCTP +
 * triage), so publishing the schedule is the only step required to send them.
 *
 * The reference documents are LINKED to SharePoint rather than attached, because
 * notify() has no attachment path. The links are static body text, so an admin
 * can repoint one in /admin/email/templates without a deploy: worth knowing that
 * two of the triage docs currently live under Archived Clinic Day Channels, and
 * the Clinical Reasoning Tool sits on a personal OneDrive, so both are likelier
 * than the rest to move or go dead.
 */

export type CcReminderParams = {
  firstName: string;
  clinicDateLabel: string;
  /** Hub IT ticketing, for Epic or Doximity access problems. */
  helpDeskUrl: string;
};

export function ccReminderContext(p: CcReminderParams): Record<string, unknown> {
  return { ...p };
}

const CC_DEFAULT_BODY = `<p>Hi {{ firstName }},</p>
<p>Thank you so much for volunteering to be our <strong>cc JCTM</strong> for clinic on {{ clinicDateLabel }}! We appreciate your help in making sure our patients get notified of their recent lab and imaging results in a timely and understandable manner.</p>
<h2>Before Clinic Day</h2>
<ul>
<li>Read over the <a href="https://yaleedu.sharepoint.com/:w:/r/sites/HAVENFreeClinic/Shared%20Documents/CA%20-%20Clinical%20Advisors/1.%20SCTM+JCTM%20Resources%20%26%20Guides/2.%20CC_JCTM_Guide_31JAN2026.docx?d=w7153c726a75f4416a24e7f25a7af5683&amp;csf=1&amp;web=1&amp;e=JCUPm8"><strong>CC JCTM Guide</strong></a>.</li>
<li>Check that you have both <strong>Epic</strong> and <strong>Doximity</strong> access. If either is not working, submit a Help Desk ticket <a href="{{ helpDeskUrl }}">here</a> as soon as possible.</li>
<li>You can touch base with us in the CA/Attending workroom on Saturday before you start.</li>
</ul>
<h2>Dot Phrases</h2>
<p>Feel free to steal the dot phrases as below:</p>
<ol>
<li>Go to the Epic search bar and type "smartphrase manager" (top of screen).</li>
<li>Type "Tyger Lin" under User (middle of screen).</li>
<li>Type the dot phrase under Search (right side of screen).</li>
</ol>
<p>Thanks so much, and let us know if you have any questions!</p>
<p>Best,<br/>HAVEN CAs</p>`;

export type TriageReminderParams = {
  firstName: string;
  clinicDateLabel: string;
  edsOnShift: string;
  clinicalAdvisorsOnShift: string;
  /** Attending covering the triage department this clinic date, or "". */
  attendingOnShift: string;
  masterScheduleUrl: string;
};

export function triageReminderContext(p: TriageReminderParams): Record<string, unknown> {
  return { ...p };
}

const TRIAGE_DEFAULT_BODY = `<p>Hi {{ firstName }},</p>
<p>Thank you for being our <strong>Triage SCTM</strong> for the week of {{ clinicDateLabel }}! You should have been added to the Triage Chat on Microsoft Teams. If not, please reach out to {{#if edsOnShift}}the Executive Director(s) on shift, <strong>{{ edsOnShift }}</strong>{{else}}the HAVEN leadership team{{/if}}.</p>
<p>Calls will be posted to the triage chat. You are then expected to return calls within a reasonable time frame. You will work closely with the Clinical Advisors{{#if attendingOnShift}} and <strong>{{ attendingOnShift }}</strong>, the on-call attending{{/if}}.</p>
<h2>Before You Start</h2>
<p>Please review the following documents:</p>
<ul>
<li><a href="https://yaleedu.sharepoint.com/:x:/r/sites/HAVENFreeClinic/Shared%20Documents/General/Triage%20To%20Do%20for%20PS,%20CA,%20%26%20Triage%20SCTM.xlsx?d=we32843a720124cd4ba7b1c9988c9c7bb&amp;csf=1&amp;web=1&amp;e=dgbalL">Triage To Do for PS, CA &amp; Triage SCTM</a></li>
<li><a href="https://yaleedu.sharepoint.com/:p:/r/sites/HAVENFreeClinic/Shared%20Documents/Archived%20Clinic%20Day%20Channels/01.13.24%20Clinic/Triage%20SCTM%20Resources/HAVEN%20On%20Call%20Triage%20Slides.pptx?d=wc29cd3cd320041a0982bc84455d1f797&amp;csf=1&amp;web=1&amp;e=cUcSxJ">HAVEN On Call Triage Slides</a></li>
<li><a href="https://yaleedu.sharepoint.com/:w:/r/sites/HAVENFreeClinic/Shared%20Documents/Archived%20Clinic%20Day%20Channels/08-03-24%20Clinic/Triage%20SCTM%20Resources/Triage%20SCTM%20protocol%20for%20ED%20follow%20up.docx?d=wbb225fccdce8470e97d802f7cd98e454&amp;csf=1&amp;web=1&amp;e=OwyiOn">Triage SCTM protocol for ED follow up</a></li>
<li><a href="https://yaleedu.sharepoint.com/:x:/r/sites/HAVENFreeClinic/Shared%20Documents/LCCN%20-%20Longitudinal%20Care%20Coordination/Protocol%20docs/ED%20and%20hospital%20discharge%20tracker.xlsx?d=wa1e1454892a349ff85ebfaa9c3af75db&amp;csf=1&amp;web=1&amp;e=KRTBFP">ED and hospital discharge tracker</a></li>
<li><a href="https://yaleedu-my.sharepoint.com/:w:/g/personal/wilton_sun_yale_edu/IQBuQ7p-vawORJzNiyxtamQ8AXTbNbA6Ad_SljgXfDJSryw?e=P8Iqai">HAVEN Free Clinic Triage SCTM Clinical Reasoning Tool</a> (example)</li>
</ul>
<h2>Questions?</h2>
<p>If you have any specific questions, feel free to reach out to {{#if edsOnShift}}the Executive Director(s) on shift, <strong>{{ edsOnShift }}</strong>{{#if clinicalAdvisorsOnShift}}, or the Clinical Advisor(s) on shift, <strong>{{ clinicalAdvisorsOnShift }}</strong>{{/if}}{{else}}{{#if clinicalAdvisorsOnShift}}the Clinical Advisor(s) on shift, <strong>{{ clinicalAdvisorsOnShift }}</strong>{{else}}the HAVEN leadership team{{/if}}{{/if}}.</p>
<p>The master schedule can be found <a href="{{ masterScheduleUrl }}">here</a>.</p>
<p>Thank you for all your hard work!</p>
<p>HAVEN EDs and CAs</p>`;

export const shiftDescriptors: TemplateDescriptor[] = [
  {
    key: "shift-reminder",
    name: "Shift: weekly reminder",
    category: "transactional",
    group: "shift",
    variables: [
      { name: "firstName", label: "Recipient first name", sampleValue: "Sam" },
      { name: "roleLabel", label: "Shift role (Director / Volunteer / Shadow)", sampleValue: "Volunteer" },
      { name: "departmentName", label: "Department name", sampleValue: "Senior Primary Care Clinical Team Member" },
      { name: "clinicDateLabel", label: "Clinic date", sampleValue: "Saturday, July 11, 2026" },
      { name: "additionalShifts", label: "Additional same-day shifts (HTML, usually empty)", sampleValue: "" },
      { name: "edsOnShift", label: "Executive Directors on shift (names)", sampleValue: "Jordan Blake, Riley Chen" },
      { name: "deptDirectorsOnShift", label: "Department directors on shift (names)", sampleValue: "Alex Rivera" },
      { name: "clinicalAdvisorsOnShift", label: "Clinical Advisors on shift (names)", sampleValue: "Dr. Pat Lee" },
      { name: "attendingOnShift", label: "Attending physician on shift (name)", sampleValue: "Dr. Morgan Ellis" },
      { name: "teamsChannelUrl", label: "This week's Teams channel link", sampleValue: "https://teams.microsoft.com/l/channel/example" },
      { name: "hipaaComplianceUrl", label: "HIPAA / compliance page link", sampleValue: "https://hub.example.org/my-info" },
      { name: "helpDeskUrl", label: "IT help desk ticket link (Epic issues)", sampleValue: "https://hub.example.org/support/new" },
      { name: "shiftSwapUrl", label: "Shift swap / coverage request link", sampleValue: "https://hub.example.org/schedule" },
      { name: "masterScheduleUrl", label: "Master schedule link", sampleValue: "https://hub.example.org/schedule/full" },
    ],
    defaultSubject: "Reminder: your HAVEN shift on {{ clinicDateLabel }}",
    defaultBody: DEFAULT_BODY,
  },
  {
    key: "shift-reminder-cc",
    name: "Shift: cc JCTM reminder",
    category: "transactional",
    group: "shift",
    variables: [
      { name: "firstName", label: "Recipient first name", sampleValue: "Sam" },
      { name: "clinicDateLabel", label: "Clinic date", sampleValue: "Saturday, July 11, 2026" },
      { name: "helpDeskUrl", label: "IT help desk ticket link (Epic / Doximity issues)", sampleValue: "https://hub.example.org/support/new" },
    ],
    defaultSubject: "You are the cc JCTM for HAVEN clinic on {{ clinicDateLabel }}",
    defaultBody: CC_DEFAULT_BODY,
  },
  {
    key: "shift-reminder-triage",
    name: "Shift: Triage SCTM reminder",
    category: "transactional",
    group: "shift",
    variables: [
      { name: "firstName", label: "Recipient first name", sampleValue: "Sam" },
      { name: "clinicDateLabel", label: "Clinic date", sampleValue: "Saturday, July 11, 2026" },
      { name: "edsOnShift", label: "Executive Directors on shift (names)", sampleValue: "Jordan Blake, Riley Chen" },
      { name: "clinicalAdvisorsOnShift", label: "Clinical Advisors on shift (names)", sampleValue: "Dr. Pat Lee" },
      { name: "attendingOnShift", label: "On-call attending (name)", sampleValue: "Dr. Morgan Ellis" },
      { name: "masterScheduleUrl", label: "Master schedule link", sampleValue: "https://hub.example.org/schedule/full" },
    ],
    defaultSubject: "You are the Triage SCTM for the week of {{ clinicDateLabel }}",
    defaultBody: TRIAGE_DEFAULT_BODY,
  },
];
