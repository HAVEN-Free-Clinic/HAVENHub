/**
 * IT Support ticket email templates for HAVEN Hub.
 *
 * Five notification points on a TechRequest's lifecycle:
 *   - support.ticket_submitted: fired on create. One shared template renders
 *     both a requester-confirmation variant and a manager-alert variant via
 *     the `isManager` boolean flag (the render engine only supports truthy
 *     {{#if}} checks on a single var, so a two-value string like a
 *     "recipientRole" cannot itself drive branching -- a boolean flag can,
 *     matching the `showCta`/`hasEhsGap` pattern already used by compliance.ts).
 *   - support.request_assigned: fired when a manager assigns (or reassigns) a
 *     ticket.
 *   - support.status_changed: fired on any status transition.
 *   - support.comment_added: fired when a PUBLIC comment is posted (internal
 *     comments are not notified).
 *   - support.request_resolved: fired when a ticket moves to RESOLVED.
 *
 * All five keys must exist here before any support.* notification can render:
 * renderEmail() throws "Unknown email template: <key>" for an unregistered key.
 */

import type { TemplateDescriptor } from "./types";

export const supportDescriptors: TemplateDescriptor[] = [
  {
    key: "support.ticket_submitted",
    name: "IT Support: ticket submitted",
    category: "transactional",
    group: "support",
    variables: [
      { name: "ticketNumber", label: "Ticket number", sampleValue: "42" },
      { name: "subject", label: "Ticket subject", sampleValue: "Laptop won't connect to WiFi" },
      { name: "link", label: "Absolute link to the ticket", sampleValue: "https://hub.havenfreeclinic.org/support/abc123" },
      { name: "isManager", label: "True for the manager-alert variant, false for the requester confirmation", sampleValue: "false" },
      { name: "requesterName", label: "Requester's name (manager variant only)", sampleValue: "Jane Doe" },
    ],
    defaultSubject:
      "{{#if isManager}}[HAVEN] New IT Support ticket #{{ ticketNumber }}{{else}}[HAVEN] Your IT Support ticket #{{ ticketNumber }} was received{{/if}}",
    defaultBody: `{{#if isManager}}<p>Hello,</p>

<p>{{ requesterName }} submitted a new IT Support ticket.</p>

<p><strong>#{{ ticketNumber }}: {{ subject }}</strong></p>

<p><a href="{{ link }}">View the ticket</a></p>{{else}}<p>Hello,</p>

<p>We received your IT Support ticket and will follow up soon.</p>

<p><strong>#{{ ticketNumber }}: {{ subject }}</strong></p>

<p><a href="{{ link }}">Track your ticket</a></p>{{/if}}

<p>Thank you,<br>HAVEN IT Support</p>`,
  },
  {
    key: "support.request_assigned",
    name: "IT Support: request assigned",
    category: "transactional",
    group: "support",
    variables: [
      { name: "ticketNumber", label: "Ticket number", sampleValue: "42" },
      { name: "subject", label: "Ticket subject", sampleValue: "Laptop won't connect to WiFi" },
      { name: "assigneeName", label: "Name of the person the ticket was assigned to", sampleValue: "Pat Manager" },
      { name: "link", label: "Absolute link to the ticket", sampleValue: "https://hub.havenfreeclinic.org/support/abc123" },
    ],
    defaultSubject: "[HAVEN] IT Support ticket #{{ ticketNumber }} assigned",
    defaultBody: `<p>Hello,</p>

<p>IT Support ticket <strong>#{{ ticketNumber }}: {{ subject }}</strong> has been assigned to {{ assigneeName }}.</p>

<p><a href="{{ link }}">View the ticket</a></p>

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
