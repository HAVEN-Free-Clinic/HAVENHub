/**
 * Email templates for shift swap and drop request notifications.
 * Sent at each stage of the request lifecycle: submitted, approved,
 * denied, and cancelled.
 */

import type { TemplateDescriptor } from "./types";

const HUB_LINK = `<a href="https://hub.havenfreeclinic.com/schedule">View your schedule in HAVEN Hub</a>`;

export type ScheduleTemplateKey =
  | "schedule-swap-submitted-requester"
  | "schedule-swap-submitted-partner"
  | "schedule-drop-submitted-requester"
  | "schedule-request-approved"
  | "schedule-request-approved-partner"
  | "schedule-request-denied"
  | "schedule-request-cancelled-partner"
  | "schedule-request-submitted-director";

export const scheduleDescriptors: TemplateDescriptor[] = [
  {
    key: "schedule-swap-submitted-requester",
    name: "Swap request submitted (requester)",
    category: "transactional",
    group: "shift",
    variables: [
      { name: "requesterName", label: "Requester first name", sampleValue: "Alex" },
      { name: "partnerName", label: "Swap partner name", sampleValue: "Jordan" },
      { name: "requesterDate", label: "Requester shift date", sampleValue: "July 15, 2026" },
      { name: "partnerDate", label: "Partner shift date", sampleValue: "July 22, 2026" },
      { name: "departmentName", label: "Department name", sampleValue: "Internal Medicine" },
    ],
    defaultSubject: "Your swap request has been submitted",
    defaultBody: `<p>Hi {{ requesterName }},</p>
<p>You have requested a <strong>shift swap</strong> for <strong>{{ requesterDate }}</strong> with <strong>{{ partnerName }}</strong> ({{ partnerDate }}) in the <strong>{{ departmentName }}</strong> department.</p>
<p>We have notified <strong>{{ partnerName }}</strong> about this request. Your department directors have also been notified and will review and approve or deny it.</p>
<p>${HUB_LINK}</p>`,
  },
  {
    key: "schedule-swap-submitted-partner",
    name: "Swap request submitted (partner)",
    category: "transactional",
    group: "shift",
    variables: [
      { name: "partnerName", label: "Partner first name", sampleValue: "Jordan" },
      { name: "requesterName", label: "Requester name", sampleValue: "Alex" },
      { name: "requesterDate", label: "Requester shift date", sampleValue: "July 15, 2026" },
      { name: "partnerDate", label: "Partner shift date", sampleValue: "July 22, 2026" },
      { name: "departmentName", label: "Department name", sampleValue: "Internal Medicine" },
    ],
    defaultSubject: "You have been requested for a shift swap",
    defaultBody: `<p>Hi {{ partnerName }},</p>
<p><strong>{{ requesterName }}</strong> has requested to swap their shift on <strong>{{ requesterDate }}</strong> with your shift on <strong>{{ partnerDate }}</strong> in the <strong>{{ departmentName }}</strong> department.</p>
<p>Your department directors will review and approve or deny the request. No action is needed from you at this time.</p>
<p>${HUB_LINK}</p>`,
  },
  {
    key: "schedule-drop-submitted-requester",
    name: "Drop request submitted (requester)",
    category: "transactional",
    group: "shift",
    variables: [
      { name: "requesterName", label: "Requester first name", sampleValue: "Alex" },
      { name: "requesterDate", label: "Shift date", sampleValue: "July 15, 2026" },
      { name: "departmentName", label: "Department name", sampleValue: "Internal Medicine" },
    ],
    defaultSubject: "Your drop request has been submitted",
    defaultBody: `<p>Hi {{ requesterName }},</p>
<p>You have requested to <strong>drop your shift</strong> on <strong>{{ requesterDate }}</strong> in the <strong>{{ departmentName }}</strong> department.</p>
<p>Your department directors will review and approve or deny the request.</p>
<p>${HUB_LINK}</p>`,
  },
  {
    key: "schedule-request-approved",
    name: "Shift request approved (requester)",
    category: "transactional",
    group: "shift",
    variables: [
      { name: "recipientName", label: "Recipient first name", sampleValue: "Alex" },
      { name: "requestType", label: "Request type (swap or drop)", sampleValue: "swap" },
      { name: "requesterDate", label: "Requester shift date", sampleValue: "July 15, 2026" },
      { name: "partnerDate", label: "Partner shift date (swap only)", sampleValue: "July 22, 2026" },
      { name: "departmentName", label: "Department name", sampleValue: "Internal Medicine" },
    ],
    defaultSubject: "Your shift request has been approved",
    defaultBody: `<p>Hi {{ recipientName }},</p>
<p>Your <strong>{{ requestType }} request</strong> for <strong>{{ requesterDate }}</strong> in the <strong>{{ departmentName }}</strong> department has been <strong>approved</strong> by your directors.</p>
<p>Your schedule has been updated accordingly.</p>
<p>${HUB_LINK}</p>`,
  },
  {
    key: "schedule-request-approved-partner",
    name: "Shift swap approved (partner)",
    category: "transactional",
    group: "shift",
    variables: [
      { name: "partnerName", label: "Partner first name", sampleValue: "Jordan" },
      { name: "requesterDate", label: "Requester shift date", sampleValue: "July 15, 2026" },
      { name: "partnerDate", label: "Partner shift date", sampleValue: "July 22, 2026" },
      { name: "departmentName", label: "Department name", sampleValue: "Internal Medicine" },
    ],
    defaultSubject: "A shift swap involving you has been approved",
    defaultBody: `<p>Hi {{ partnerName }},</p>
<p>A shift swap has been <strong>approved</strong> involving your shift on <strong>{{ partnerDate }}</strong> and <strong>{{ requesterDate }}</strong> in the <strong>{{ departmentName }}</strong> department.</p>
<p>Your schedule has been updated accordingly.</p>
<p>${HUB_LINK}</p>`,
  },
  {
    key: "schedule-request-denied",
    name: "Shift request denied (requester)",
    category: "transactional",
    group: "shift",
    variables: [
      { name: "requesterName", label: "Requester first name", sampleValue: "Alex" },
      { name: "requestType", label: "Request type (swap or drop)", sampleValue: "swap" },
      { name: "requesterDate", label: "Shift date", sampleValue: "July 15, 2026" },
      { name: "departmentName", label: "Department name", sampleValue: "Internal Medicine" },
    ],
    defaultSubject: "Your shift request has been denied",
    defaultBody: `<p>Hi {{ requesterName }},</p>
<p>Your <strong>{{ requestType }} request</strong> for <strong>{{ requesterDate }}</strong> in the <strong>{{ departmentName }}</strong> department has been <strong>denied</strong> by your directors.</p>
<p>Please reach out to your department directors if you have any questions.</p>
<p>${HUB_LINK}</p>`,
  },
  {
    key: "schedule-request-cancelled-partner",
    name: "Swap request withdrawn (partner)",
    category: "transactional",
    group: "shift",
    variables: [
      { name: "partnerName", label: "Partner first name", sampleValue: "Jordan" },
      { name: "requesterName", label: "Requester name", sampleValue: "Alex" },
      { name: "partnerDate", label: "Partner shift date", sampleValue: "July 22, 2026" },
      { name: "departmentName", label: "Department name", sampleValue: "Internal Medicine" },
    ],
    defaultSubject: "A shift swap request involving you has been withdrawn",
    defaultBody: `<p>Hi {{ partnerName }},</p>
<p><strong>{{ requesterName }}</strong> has withdrawn their shift swap request involving your shift on <strong>{{ partnerDate }}</strong> in the <strong>{{ departmentName }}</strong> department.</p>
<p>No action is needed from you.</p>
<p>${HUB_LINK}</p>`,
  },
  {
    key: "schedule-request-submitted-director",
    name: "New shift request - director notification",
    category: "transactional",
    group: "shift",
    variables: [
      { name: "directorName", label: "Director first name", sampleValue: "Sam" },
      { name: "requesterName", label: "Requester name", sampleValue: "Alex Johnson" },
      { name: "requestType", label: "Request type (swap or drop)", sampleValue: "swap" },
      { name: "requesterDate", label: "Requester shift date", sampleValue: "July 15, 2026" },
      { name: "partnerName", label: "Swap partner name (swap only)", sampleValue: "Jordan" },
      { name: "partnerDate", label: "Partner shift date (swap only)", sampleValue: "July 22, 2026" },
      { name: "departmentName", label: "Department name", sampleValue: "Internal Medicine" },
    ],
    defaultSubject: "New shift request pending review",
    defaultBody: `<p>Hi {{ directorName }},</p>
<p><strong>{{ requesterName }}</strong> has submitted a <strong>{{ requestType }} request</strong> for <strong>{{ requesterDate }}</strong>{{#if partnerName}} with <strong>{{ partnerName }}</strong> ({{ partnerDate }}){{/if}} in the <strong>{{ departmentName }}</strong> department.</p>
<p>Please review and approve or deny the request in HAVEN Hub.</p>
<p><a href="https://hub.havenfreeclinic.com/schedule/builder">Review pending requests</a></p>`,
  },
  {
    key: "schedule-request-denied-partner",
    name: "Shift swap denied (partner)",
    category: "transactional",
    group: "shift",
    variables: [
      { name: "partnerName", label: "Partner first name", sampleValue: "Jordan" },
      { name: "requesterName", label: "Requester name", sampleValue: "Alex Johnson" },
      { name: "requesterDate", label: "Requester shift date", sampleValue: "July 15, 2026" },
      { name: "partnerDate", label: "Partner shift date", sampleValue: "July 22, 2026" },
      { name: "departmentName", label: "Department name", sampleValue: "Internal Medicine" },
    ],
    defaultSubject: "A shift swap request involving you has been denied",
    defaultBody: `<p>Hi {{ partnerName }},</p>
<p>A shift swap request submitted by <strong>{{ requesterName }}</strong> involving your shift on <strong>{{ partnerDate }}</strong> and their shift on <strong>{{ requesterDate }}</strong> in the <strong>{{ departmentName }}</strong> department has been <strong>denied</strong> by your directors.</p>
<p>No action is needed from you. Your schedule remains unchanged.</p>
<p>${HUB_LINK}</p>`,
  },
];

