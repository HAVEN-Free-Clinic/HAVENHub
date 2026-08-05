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
];
