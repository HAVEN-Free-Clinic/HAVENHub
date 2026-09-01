/**
 * Volunteers module email templates.
 *
 * volunteers.self_withdrawal: sent to the people who can execute an offboard
 * (volunteers.manage_offboarding holders and admins) when a member uses My Info
 * to declare they are not volunteering this term. Their volunteer memberships
 * are already removed by the time this sends; the message tells ops that the
 * person still has an ACTIVE account and Epic access until someone processes it.
 *
 * The body branches on stillActive: a member who keeps another role this term
 * (typically a director who also took clinic shifts) is deliberately NOT flagged
 * for offboarding, because executing one would strip their remaining role.
 *
 * Department codes arrive pre-joined: the render engine has no {{#each}}.
 */

import type { TemplateDescriptor } from "./types";
import { esc } from "../render/escape";

export type PendingLanguageClaim = { name: string; language: string };

/**
 * The claims list as <li> rows for the {{{ claimRowsHtml }}} slot. The render
 * engine has no {{#each}}, so a list has to arrive pre-rendered; every value is
 * escaped here because both halves are member-entered.
 */
export function claimRowsToHtml(claims: PendingLanguageClaim[]): string {
  return claims.map((c) => `<li>${esc(c.name)} -- ${esc(c.language)}</li>`).join("");
}

export type LanguageClaimedParams = {
  /** Reviewer's first name. */
  firstName: string;
  /** The claims waiting, already sorted. */
  claims: PendingLanguageClaim[];
  /** Absolute link to the language review queue. */
  reviewLink: string;
};

/** Build the flat render-engine context for the volunteers.language_claimed template. */
export function languageClaimedContext(p: LanguageClaimedParams): Record<string, unknown> {
  const single = p.claims.length === 1;
  return {
    firstName: p.firstName,
    claimCount: p.claims.length,
    isSingle: single,
    singleName: single ? p.claims[0].name : "",
    singleLanguage: single ? p.claims[0].language : "",
    claimRowsHtml: claimRowsToHtml(p.claims),
    reviewLink: p.reviewLink,
  };
}

export type SelfWithdrawalParams = {
  /** Full name of the member who withdrew. */
  memberName: string;
  /** Comma-joined department codes they withdrew from, e.g. "MED, PCAR". */
  departments: string;
  /** Free-text reason they gave, or null. */
  reason: string | null;
  /** True when the member keeps another ACTIVE membership this term (no flag was raised). */
  stillActive: boolean;
  /** Absolute link to the offboarding queue. */
  reviewLink: string;
};

/** Build the flat render-engine context for the volunteers.self_withdrawal template. */
export function selfWithdrawalContext(p: SelfWithdrawalParams): Record<string, unknown> {
  return {
    memberName: p.memberName,
    departments: p.departments,
    reason: p.reason ?? "",
    hasReason: p.reason !== null && p.reason !== "",
    stillActive: p.stillActive,
    reviewLink: p.reviewLink,
  };
}

export const volunteersDescriptors: TemplateDescriptor[] = [
  {
    key: "volunteers.self_withdrawal",
    name: "Volunteers: not returning this term",
    category: "transactional",
    group: "volunteers",
    variables: [
      { name: "memberName", label: "Member who withdrew", sampleValue: "Jane Doe" },
      {
        name: "departments",
        label: "Departments they withdrew from (comma-joined)",
        sampleValue: "MED, PCAR",
      },
      { name: "reason", label: "Reason they gave (empty when none)", sampleValue: "Graduating in May." },
      { name: "hasReason", label: "True when a reason was given", sampleValue: "true" },
      {
        name: "stillActive",
        label: "True when they keep another active role this term",
        sampleValue: "false",
      },
      {
        name: "reviewLink",
        label: "Link to the offboarding queue",
        sampleValue: "https://hub.havenfreeclinic.org/volunteers/offboarding",
      },
    ],
    defaultSubject: "[HAVEN] {{ memberName }} is not volunteering this term",
    defaultBody: `<p>Hello,</p>

<p>{{ memberName }} used My Info to declare they are not volunteering this term. Their volunteer assignments ({{ departments }}) have been removed from the current-term roster.</p>

{{#if hasReason}}<p>Reason given: {{ reason }}</p>{{/if}}

{{#if stillActive}}<p>They still hold another active role this term, so they have not been added to the offboarding queue. No action is needed unless you decide otherwise.</p>{{else}}<p>They are now flagged for offboarding. Their account status and Epic access stay unchanged until someone processes the offboard.</p>{{/if}}

<p><a href="{{ reviewLink }}">Open the offboarding queue</a></p>

<p>Thank you,<br>HAVEN Free Clinic</p>`,
  },
  {
    // Sent to the MEMBER when the interpreting department assesses a language
    // they claimed. Both outcomes are sent: a claim that was assessed and not
    // confirmed leaves the queue silently otherwise, and the member would keep
    // believing they are on record as a language provider when they are not.
    //
    // The two outcomes share one template and branch on `verified`, so the
    // wording of the two cannot drift and an admin editing one sees both.
    key: "volunteers.language_assessed",
    name: "Volunteers: language assessment result",
    category: "transactional",
    group: "volunteers",
    variables: [
      { name: "firstName", label: "Member first name", sampleValue: "Sam" },
      { name: "languageLabel", label: "Language assessed", sampleValue: "Spanish" },
      { name: "verified", label: "True when confirmed", sampleValue: "true" },
      { name: "note", label: "Assessor's note (empty when none)", sampleValue: "" },
      { name: "hasNote", label: "True when a note was given", sampleValue: "false" },
      {
        name: "myInfoLink",
        label: "Link to the member's own profile",
        sampleValue: "https://hub.havenfreeclinic.org/my-info",
      },
    ],
    defaultSubject: "[HAVEN] Your {{ languageLabel }} language assessment",
    defaultBody: `<p>Hi {{ firstName }},</p>

{{#if verified}}<p>The interpreting department has confirmed your {{ languageLabel }}. You are now on record as a {{ languageLabel }} provider, and directors will see this when building the clinic schedule.</p>{{else}}<p>The interpreting department has reviewed your {{ languageLabel }} and has not confirmed it at this time. You are not on record as a {{ languageLabel }} provider, so you will not be scheduled in that role.</p>

<p>This is not a mark against you and it can be revisited. If you would like to be reassessed, reply to this email or speak to the interpreting department.</p>{{/if}}

{{#if hasNote}}<p>Note from the assessor: {{ note }}</p>{{/if}}

<p>You can see your current record <a href="{{ myInfoLink }}">here</a>.</p>

<p>Thank you,<br>HAVEN Free Clinic</p>`,
  },
  {
    // Sent to the reviewers who hold volunteers.verify_spanish when volunteers
    // self-report a language and land in the assessment queue.
    //
    // One digest per reviewer, not one message per claim: promoting a cycle
    // cohort creates dozens of claims in a single transaction, and a message
    // each buried the reviewers. The body branches on isSingle so the common
    // one-claim case still reads as a sentence rather than a list of one.
    key: "volunteers.language_claimed",
    name: "Volunteers: language claim needs review",
    category: "transactional",
    group: "volunteers",
    variables: [
      { name: "firstName", label: "Reviewer first name", sampleValue: "Alex" },
      { name: "claimCount", label: "How many claims are waiting", sampleValue: "3" },
      { name: "isSingle", label: "True when exactly one claim is waiting", sampleValue: "false" },
      { name: "singleName", label: "Claimant name when there is exactly one", sampleValue: "Sam Rivera" },
      { name: "singleLanguage", label: "Language when there is exactly one", sampleValue: "Spanish" },
      {
        name: "claimRowsHtml",
        label: "The waiting claims as list rows",
        sampleValue: "<li>Sam Rivera -- Spanish</li>",
      },
      {
        name: "reviewLink",
        label: "Link to the language review queue",
        sampleValue: "https://hub.havenfreeclinic.org/volunteers/spanish-review",
      },
    ],
    defaultSubject: "[HAVEN] Language claims awaiting your review",
    defaultBody: `<p>Hi {{ firstName }},</p>

{{#if isSingle}}<p><strong>{{ singleName }}</strong> has reported speaking {{ singleLanguage }} and is waiting on an assessment.</p>{{else}}<p>{{ claimCount }} volunteers have reported speaking a language and are waiting on an assessment:</p>

<ul>{{{ claimRowsHtml }}}</ul>{{/if}}

<p><a href="{{ reviewLink }}">Open the language review queue</a></p>

<p>Thank you,<br>HAVEN Free Clinic</p>`,
  },
];
