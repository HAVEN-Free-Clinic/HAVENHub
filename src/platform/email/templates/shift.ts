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
  teamsChannelUrl: string;
  hipaaComplianceUrl: string;
  shiftSwapUrl: string;
  masterScheduleUrl: string;
};

export function shiftReminderContext(p: ShiftReminderParams): Record<string, unknown> {
  return { ...p };
}

const DEFAULT_BODY = `<p>Hello {{ firstName }},</p>
<p>This is a friendly reminder that you are scheduled for a <strong>{{ roleLabel }}</strong> Shift in the <strong>{{ departmentName }}</strong> department at HAVEN Free Clinic this {{ clinicDateLabel }}.</p>
{{{ additionalShifts }}}
<p>As we move into the summer, we are piloting a more centralized process for clinic-day reminders and volunteer communication. We appreciate your patience as we refine this process through trial and error. Our goal is to improve consistency, accountability, and communication across the clinic.</p>
<h2>Shift Details</h2>
<p><strong>Date:</strong> {{ clinicDateLabel }}<br/>
<strong>Time:</strong> 8:00 AM to 2:00 PM<br/>
<strong>Location:</strong> Yale Physicians Building, 800 Howard Avenue, Floor 1, New Haven, CT 06519 (there is free parking on Saturdays)</p>
<h2>Before Your Shift</h2>
<ul>
<li>Please verify your Epic access by Wednesday before your shift. If you are experiencing issues, submit a Help Desk ticket <a href="https://airtable.com/appkxTQ19GmaHgW1O/pag0u41BHqicULzXQ/form">here</a> as soon as possible. We are unable to accommodate Epic-related requests submitted after Wednesday, so please plan ahead.</li>
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
<p>For urgent clinic-day concerns, please contact{{#if edsOnShift}} the Executive Director(s) on shift, <strong>{{ edsOnShift }}</strong>,{{/if}}{{#if deptDirectorsOnShift}} or your department director(s) on shift, <strong>{{ deptDirectorsOnShift }}</strong>{{/if}}.</p>
{{#if clinicalAdvisorsOnShift}}<p>Clinical Advisor(s) on shift: <strong>{{ clinicalAdvisorsOnShift }}</strong></p>{{/if}}
<p>The master schedule can be found <a href="{{ masterScheduleUrl }}">here</a>.</p>
<p>Thank you for your commitment to our patients and to HAVEN. We look forward to seeing you on Saturday!</p>`;

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
      { name: "teamsChannelUrl", label: "This week's Teams channel link", sampleValue: "https://teams.microsoft.com/l/channel/example" },
      { name: "hipaaComplianceUrl", label: "HIPAA / compliance page link", sampleValue: "https://hub.example.org/my-info" },
      { name: "shiftSwapUrl", label: "Shift swap / coverage request link", sampleValue: "https://hub.example.org/schedule" },
      { name: "masterScheduleUrl", label: "Master schedule link", sampleValue: "https://hub.example.org/schedule/full" },
    ],
    defaultSubject: "Reminder: your HAVEN shift on {{ clinicDateLabel }}",
    defaultBody: DEFAULT_BODY,
  },
];
