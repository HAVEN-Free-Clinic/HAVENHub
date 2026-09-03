/**
 * Event check-in templates.
 *
 * One template, two audiences, which is why the call to action is a pair of
 * variables rather than a branch: the render engine has no conditionals (see
 * platform/email/render/render.ts), so the context builder decides where the
 * button points. A member with an account is sent to /get-started; a walk-up
 * with no account at all is sent to the application portal, because telling
 * someone with no Person row to "sign in and finish onboarding" points at a door
 * that does not open for them.
 *
 * Lists are pre-rendered into a {{{ raw }}} slot for the same reason the
 * clearance templates do it, and every interpolated value is escaped first.
 */

import { esc } from "@/platform/email/render/escape";
import { itemsToHtml } from "./clearance";
import type { TemplateDescriptor } from "./types";

export type AttendanceNudgeParams = {
  personName: string;
  eventTitle: string;
  /** Already formatted in the display zone by the caller. */
  eventDate: string;
  /** Ready-to-display sentences, one per outstanding item. */
  items: string[];
  ctaUrl: string;
  ctaLabel: string;
  /** Resolved `branding.brandColor`, used for the CTA button background. */
  brandColor?: string;
};

export function attendanceNudgeContext(p: AttendanceNudgeParams): Record<string, unknown> {
  const count = p.items.length;
  return {
    personName: p.personName,
    eventTitle: p.eventTitle,
    eventDate: p.eventDate,
    itemsHtml: itemsToHtml(p.items),
    itemCount: count,
    itemNoun: count === 1 ? "item" : "items",
    // "is" / "are" agreement, matching how clearance-digest handles its count.
    itemVerb: count === 1 ? "is" : "are",
    ctaUrl: p.ctaUrl,
    ctaLabel: esc(p.ctaLabel),
    brandColor: p.brandColor ?? "",
  };
}

export const attendanceDescriptors: TemplateDescriptor[] = [
  {
    key: "attendance-nudge",
    name: "Attendance: checked in with onboarding outstanding",
    category: "transactional",
    group: "compliance",
    variables: [
      { name: "personName", label: "Attendee name", sampleValue: "Jane Doe" },
      { name: "eventTitle", label: "Event title", sampleValue: "Fall 2026 volunteer training" },
      { name: "eventDate", label: "Event date and time, already formatted", sampleValue: "September 3, 2026 at 6:00 PM" },
      {
        name: "itemsHtml",
        label: "Pre-rendered <li> rows, one per outstanding item",
        sampleValue: "<li>Complete and upload your HIPAA certificate</li>",
      },
      { name: "itemCount", label: "How many items are outstanding", sampleValue: "2" },
      { name: "itemNoun", label: "\"item\" or \"items\", matched to the count", sampleValue: "items" },
      { name: "itemVerb", label: "\"is\" or \"are\", matched to the count", sampleValue: "are" },
      {
        name: "ctaUrl",
        label: "Where the button points: the get-started checklist for a member, the application portal for a walk-up",
        sampleValue: "https://hub.havenfreeclinic.org/get-started",
      },
      { name: "ctaLabel", label: "Button text, matched to where it points", sampleValue: "Finish onboarding" },
      { name: "brandColor", label: "Brand color for the call-to-action button background (hex)", sampleValue: "#00356b" },
    ],
    defaultSubject: "[HAVEN] We recorded your attendance, but {{ itemCount }} {{ itemNoun }} {{ itemVerb }} outstanding",
    defaultBody: `<p>Hello {{ personName }},</p>

<p>Your attendance at <strong>{{ eventTitle }}</strong> on {{ eventDate }} has been recorded. Thank you for coming.</p>

<p>Your onboarding is not finished yet, though, and until it is your attendance cannot be credited toward your clearance to volunteer. {{ itemCount }} {{ itemNoun }} {{ itemVerb }} outstanding:</p>

<ul>{{{ itemsHtml }}}</ul>

<table role="presentation" cellpadding="0" cellspacing="0" style="margin: 0 0 18px;">
  <tr>
    <td style="border-radius: 6px; background-color: {{ brandColor }};">
      <a href="{{ ctaUrl }}" style="display: inline-block; padding: 12px 24px; font-family: 'Hanken Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 15px; font-weight: 600; color: #ffffff; text-decoration: none;">{{ ctaLabel }} &rarr;</a>
    </td>
  </tr>
</table>

<p>Please take care of these promptly so your attendance counts. Reach out to your director if you are unsure how to complete any of them.</p>

<p>Thank you,<br>HAVEN Free Clinic</p>`,
  },
];
