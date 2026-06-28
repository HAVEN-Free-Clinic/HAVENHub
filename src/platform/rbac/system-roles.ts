/**
 * Canonical system-role definitions: the single source of truth for both the
 * dev seed (prisma/seed.ts) and the production backfill migrations. Director and
 * Volunteer are auto-attached by the RBAC engine from TermMembership.kind
 * (see engine.ts MEMBERSHIP_KIND_ROLE); the rest are assigned explicitly.
 *
 * This module is intentionally side-effect free (pure data, no imports) so the
 * seed, migrations, and tests can all import the exact shipped grant lists.
 */
export type SystemRole = { name: string; description: string; grants: string[] };

export const SYSTEM_ROLES: SystemRole[] = [
  {
    name: "Platform Admin",
    description: "Full access to every module and admin function",
    grants: ["*"],
  },
  {
    name: "Director",
    description: "Baseline access for current-term directors",
    // learning.access: directors are assigned department/org-wide courses like
    // any active member, so they must be able to open them or the onboarding
    // gate locks them out of the app (issue #65).
    grants: ["schedule.view", "schedule.edit_own_dept", "volunteers.view", "my-info.access", "learning.access"],
  },
  {
    name: "Volunteer",
    description: "Baseline access for current-term volunteers",
    grants: ["schedule.view", "my-info.access", "learning.access"],
  },
  {
    name: "Compliance Manager",
    description: "Master compliance view across the clinic",
    grants: ["volunteers.view", "volunteers.manage_compliance"],
  },
  {
    name: "Volunteer Operations Manager",
    description: "Offboarding, Epic requests, and disciplinary across the clinic",
    grants: ["volunteers.view", "volunteers.manage_offboarding", "volunteers.manage_epic", "volunteers.issue_disciplinary"],
  },
];
