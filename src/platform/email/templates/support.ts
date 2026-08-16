/**
 * IT Support ticket email templates for HAVEN Hub.
 *
 * Six templates cover a TechRequest's lifecycle. Ticket creation notifies the
 * requester and the managers separately, each with its own template (there is
 * no shared "isManager" flag):
 *   - support.ticket_submitted: fired on create; the requester-facing
 *     confirmation that we logged their request.
 *   - support.ticket_manager_alert: fired on create; the manager-facing alert
 *     that a new ticket needs triage.
 *   - support.status_changed: fired on any status transition, and ONLY for a
 *     ticket with no intercomConversationId -- a linked ticket's member hears
 *     about it in their Intercom conversation instead.
 *   - support.comment_added: same linked/unlinked split, and internal comments
 *     are never notified.
 *   - support.request_resolved: same linked/unlinked split.
 *
 * There is deliberately no assignment template. Assignment is triage
 * bookkeeping between IT managers, who now work tickets in Intercom's inbox,
 * where assignment is shown and notified natively; a second Hub-authored email
 * saying the same thing is noise in a channel nobody watches for it. The
 * requester was never told about assignment either way.
 *
 * All five keys must exist here before any support.* notification can render:
 * renderEmail() throws "Unknown email template: <key>" for an unregistered key.
 */

import type { TemplateDescriptor } from "./types";

export const supportDescriptors: TemplateDescriptor[] = [
  {
    key: "support.ticket_submitted",
    name: "IT Support: ticket received (to requester)",
    category: "transactional",
    group: "support",
    variables: [
      { name: "ticketNumber", label: "Ticket number", sampleValue: "42" },
      { name: "subject", label: "Ticket subject", sampleValue: "Laptop won't connect to WiFi" },
      { name: "link", label: "Absolute link to the ticket", sampleValue: "https://hub.havenfreeclinic.org/support/abc123" },
    ],
    defaultSubject: "[HAVEN] We received your IT Support request #{{ ticketNumber }}",
    defaultBody: `<p>Hello,</p>

<p>Thanks for reaching out to IT Support. We have logged your request and someone on the team will follow up. You will get an email as the ticket is updated, and you can reply on it any time.</p>

<p><strong>#{{ ticketNumber }}: {{ subject }}</strong></p>

<p><a href="{{ link }}">Track your request</a></p>

<p>Thank you,<br>HAVEN IT Support</p>`,
  },
  {
    key: "support.ticket_manager_alert",
    name: "IT Support: new-ticket alert (to managers)",
    category: "transactional",
    group: "support",
    variables: [
      { name: "ticketNumber", label: "Ticket number", sampleValue: "42" },
      { name: "subject", label: "Ticket subject", sampleValue: "Laptop won't connect to WiFi" },
      { name: "category", label: "Category label", sampleValue: "General IT" },
      { name: "requesterName", label: "Requester's name", sampleValue: "Jane Doe" },
      { name: "link", label: "Absolute link to the ticket", sampleValue: "https://hub.havenfreeclinic.org/support/abc123" },
    ],
    defaultSubject: "[HAVEN] New IT Support ticket #{{ ticketNumber }} from {{ requesterName }}",
    defaultBody: `<p>Hello,</p>

<p><strong>{{ requesterName }}</strong> submitted a new IT Support request that needs triage.</p>

<p><strong>#{{ ticketNumber }}: {{ subject }}</strong><br>
Category: {{ category }}</p>

<p><a href="{{ link }}">Review and assign it</a></p>

<p>Thank you,<br>HAVEN IT Support</p>`,
  },
  {
    key: "support.status_changed",
    name: "IT Support: status changed",
    category: "transactional",
    group: "support",
    variables: [
      { name: "ticketNumber", label: "Ticket number", sampleValue: "42" },
      { name: "subject", label: "Ticket subject", sampleValue: "Laptop won't connect to WiFi" },
      { name: "statusLabel", label: "Human-readable new status", sampleValue: "In Progress" },
      { name: "link", label: "Absolute link to the ticket", sampleValue: "https://hub.havenfreeclinic.org/support/abc123" },
    ],
    defaultSubject: "[HAVEN] IT Support ticket #{{ ticketNumber }} update",
    defaultBody: `<p>Hello,</p>

<p>IT Support ticket <strong>#{{ ticketNumber }}: {{ subject }}</strong> is now <strong>{{ statusLabel }}</strong>.</p>

<p><a href="{{ link }}">View the ticket</a></p>

<p>Thank you,<br>HAVEN IT Support</p>`,
  },
  {
    key: "support.comment_added",
    name: "IT Support: new comment",
    category: "transactional",
    group: "support",
    variables: [
      { name: "ticketNumber", label: "Ticket number", sampleValue: "42" },
      { name: "subject", label: "Ticket subject", sampleValue: "Laptop won't connect to WiFi" },
      { name: "authorName", label: "Name of the person who commented", sampleValue: "Pat Manager" },
      { name: "link", label: "Absolute link to the ticket", sampleValue: "https://hub.havenfreeclinic.org/support/abc123" },
    ],
    defaultSubject: "[HAVEN] New comment on IT Support ticket #{{ ticketNumber }}",
    defaultBody: `<p>Hello,</p>

<p>{{ authorName }} added a comment on IT Support ticket <strong>#{{ ticketNumber }}: {{ subject }}</strong>.</p>

<p><a href="{{ link }}">View the comment</a></p>

<p>Thank you,<br>HAVEN IT Support</p>`,
  },
  {
    key: "support.request_resolved",
    name: "IT Support: request resolved",
    category: "transactional",
    group: "support",
    variables: [
      { name: "ticketNumber", label: "Ticket number", sampleValue: "42" },
      { name: "subject", label: "Ticket subject", sampleValue: "Laptop won't connect to WiFi" },
      { name: "resolution", label: "Resolution note (optional)", sampleValue: "Reset the WiFi adapter driver." },
      { name: "hasResolution", label: "True when a resolution note was provided", sampleValue: "true" },
      { name: "link", label: "Absolute link to the ticket", sampleValue: "https://hub.havenfreeclinic.org/support/abc123" },
    ],
    defaultSubject: "[HAVEN] IT Support ticket #{{ ticketNumber }} resolved",
    defaultBody: `<p>Hello,</p>

<p>Your IT Support ticket <strong>#{{ ticketNumber }}: {{ subject }}</strong> has been resolved.</p>

{{#if hasResolution}}<p>{{ resolution }}</p>{{/if}}

<p>If this didn't fix things, reply on the ticket and we'll follow up.</p>

<p><a href="{{ link }}">View the ticket</a></p>

<p>Thank you,<br>HAVEN IT Support</p>`,
  },
];
