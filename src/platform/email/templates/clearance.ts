/**
 * Clearance email templates for HAVEN Hub.
 *
 * These cover everything the HIPAA certificate templates in ./compliance.ts do not:
 *   - onboarding-reminder: sent to a member with outstanding onboarding requirements
 *     (profile, EHS training, volunteer/director training, learning courses).
 *   - clearance-digest: the weekly per-director roll-up of members who are not
 *     cleared, which replaced the old per-member escalation.
 *
 * Both render lists, and the template engine has no {{#each}}, so list rows are
 * pre-rendered into a {{{ ... }}} slot here. That slot is NOT escaped by the render
 * engine, so every interpolated value passes through esc() first.
 */

import { esc } from "@/platform/email/render/escape";
import type { TemplateDescriptor } from "./types";

// ---------------------------------------------------------------------------
// Param types
// ---------------------------------------------------------------------------

export type OnboardingReminderParams = {
  personName: string;
  /** Ready-to-display sentences, one per outstanding requirement. */
  items: string[];
  /** Base URL of the hub, used to build the "Get started" call-to-action. */
  appUrl?: string;
  /** Resolved `branding.brandColor`, used for the CTA button background. */
  brandColor?: string;
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Render sentences as <li> rows for a {{{ raw }}} slot. Unlike the version this
 * replaced, every item is escaped: item text now interpolates admin-entered EHS
 * course names, so it is no longer a set of hardcoded internal labels.
 */
export function itemsToHtml(items: string[]): string {
  return items.map((i) => `<li>${esc(i)}</li>`).join("");
}

// ---------------------------------------------------------------------------
// Context builders
// ---------------------------------------------------------------------------

export type ClearanceDigestMember = {
  name: string;
  departmentName: string;
  /** Outstanding items across both streams, as ready-to-display sentences. */
  items: string[];
  /** Whole days since the member first went unsatisfied. */
  stalledDays: number;
  /** True when the member has been stalled past the overdue threshold. */
  flagged: boolean;
};

export type ClearanceDigestParams = {
  directorName: string;
  /** Comma-joined names of the departments this digest covers. */
  departmentNames: string;
  /** Members not cleared, already sorted longest-stalled first. */
  members: ClearanceDigestMember[];
  /** Absolute link to the volunteers surface, which directors can open. */
  reviewUrl: string;
};

export function onboardingReminderContext(p: OnboardingReminderParams): Record<string, unknown> {
  const count = p.items.length;
  return {
    personName: p.personName,
    itemsHtml: itemsToHtml(p.items),
    itemCount: count,
    itemNoun: count === 1 ? "item" : "items",
    ctaUrl: `${p.appUrl ?? ""}/get-started`,
    brandColor: p.brandColor ?? "",
  };
}

export function clearanceDigestContext(p: ClearanceDigestParams): Record<string, unknown> {
  const rows = p.members.map((m) => {
    const since = ` outstanding ${m.stalledDays} day${m.stalledDays === 1 ? "" : "s"}`;
    const flag = m.flagged ? " <strong>(overdue)</strong>" : "";
    return (
      `<li><strong>${esc(m.name)}</strong> (${esc(m.departmentName)})${since}${flag}` +
      `<ul>${itemsToHtml(m.items)}</ul></li>`
    );
  });
  const count = p.members.length;
  return {
    directorName: p.directorName,
    departmentNames: p.departmentNames,
    memberCount: count,
    memberNoun: count === 1 ? "member" : "members",
    // The subject reads "N member(s) is/are not cleared", so the verb has to agree
    // with the count as well as the noun.
    memberVerb: count === 1 ? "is" : "are",
    memberRowsHtml: rows.join(""),
    reviewUrl: p.reviewUrl,
  };
}

// ---------------------------------------------------------------------------
// Descriptors
// ---------------------------------------------------------------------------

export const clearanceDescriptors: TemplateDescriptor[] = [
  {
    key: "onboarding-reminder",
    name: "Onboarding: outstanding requirements",
    category: "transactional",
    group: "compliance",
    variables: [
      { name: "personName", label: "Member name", sampleValue: "Jane Doe" },
      {
        name: "itemsHtml",
        label: "Pre-rendered <li> rows, one per outstanding requirement",
        sampleValue: "<li>Complete your assigned learning courses</li>",
      },
      { name: "itemCount", label: "How many requirements are outstanding", sampleValue: "2" },
      { name: "itemNoun", label: "\"item\" or \"items\", matched to the count", sampleValue: "items" },
      {
        name: "ctaUrl",
        label: "Absolute link to the get-started checklist in HAVEN Hub",
        sampleValue: "https://hub.havenfreeclinic.org/get-started",
      },
      {
        name: "brandColor",
        label: "Brand color for the call-to-action button background (hex)",
        sampleValue: "#00356b",
      },
    ],
    defaultSubject: "[HAVEN] Outstanding onboarding requirements",
    defaultBody: `<p>Hello {{ personName }},</p>

<p>You have {{ itemCount }} {{ itemNoun }} left to finish before you are cleared to volunteer:</p>

<ul>{{{ itemsHtml }}}</ul>

<table role="presentation" cellpadding="0" cellspacing="0" style="margin: 0 0 18px;">
  <tr>
    <td style="border-radius: 6px; background-color: {{ brandColor }};">
      <a href="{{ ctaUrl }}" style="display: inline-block; padding: 12px 24px; font-family: 'Hanken Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 15px; font-weight: 600; color: #ffffff; text-decoration: none;">Finish onboarding &rarr;</a>
    </td>
  </tr>
</table>

<p>Reach out to your director if you are unsure how to complete any of these.</p>

<p>Thank you,<br>HAVEN Free Clinic</p>`,
  },
  {
    key: "clearance-digest",
    name: "Clearance: weekly digest (directors)",
    category: "transactional",
    group: "compliance",
    variables: [
      { name: "directorName", label: "Director name", sampleValue: "Dr. Smith" },
      { name: "departmentNames", label: "Comma-joined department names this digest covers", sampleValue: "Cardiology" },
      { name: "memberCount", label: "How many members are not cleared", sampleValue: "2" },
      { name: "memberNoun", label: "\"member\" or \"members\", matched to the count", sampleValue: "members" },
      { name: "memberVerb", label: "\"is\" or \"are\", matched to the count", sampleValue: "are" },
      {
        name: "memberRowsHtml",
        label: "Pre-rendered <li> rows, one per member, each with a nested list of outstanding items",
        sampleValue: "<li><strong>Jane Doe</strong> (Cardiology) outstanding 30 days<ul><li>HIPAA certification: expired</li></ul></li>",
      },
      { name: "reviewUrl", label: "Absolute link to the volunteers surface", sampleValue: "https://hub.havenfreeclinic.org/volunteers" },
    ],
    defaultSubject: "[HAVEN] {{ memberCount }} {{ memberNoun }} {{ memberVerb }} not cleared",
    defaultBody: `<p>Hello {{ directorName }},</p>

<p>{{ memberCount }} {{ memberNoun }} in {{ departmentNames }} {{ memberVerb }} not yet cleared to volunteer. Longest outstanding first:</p>

<ul>{{{ memberRowsHtml }}}</ul>

<p><a href="{{ reviewUrl }}">Open the volunteers list</a></p>

<p>Thank you,<br>HAVEN Free Clinic</p>`,
  },
];
