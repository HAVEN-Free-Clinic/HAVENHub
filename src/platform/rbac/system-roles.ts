/**
 * Canonical system-role definitions: the single source of truth for both the
 * dev seed (prisma/seed.ts) and the production backfill migrations. Baseline
 * Director/Volunteer access is provisioned as kind-target RoleAssignment rows
 * (seed plus backfill migration), not auto-attached in code; the rest are
 * assigned explicitly.
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
    // schedule.manage_attendance: directors run clinic day and mark walk-in
    // attendance when self check-in cannot happen.
    grants: [
      "schedule.view",
      "volunteers.view",
      "learning.access",
      "incidents.view_strikes",
      "schedule.manage_attendance",
    ],
  },
  {
    name: "Volunteer",
    description: "Baseline access for current-term volunteers",
    grants: ["schedule.view", "learning.access"],
  },
  {
    name: "Compliance Manager",
    description: "Master compliance view across the clinic",
    grants: ["volunteers.view", "volunteers.manage_compliance"],
  },
  {
    name: "Faculty Relations Manager",
    description: "Maintains the attending roster, the attending schedule, and attending credentialing",
    // Attendings are faculty, not clinic members: they hold no TermMembership
    // and belong to no department, so this cannot be a department-scoped
    // directorship. schedule.view comes along because the roster is only
    // meaningful next to the schedule it staffs.
    grants: ["schedule.view", "schedule.manage_attendings"],
  },
  {
    name: "Attending",
    description: "Hub access for a rostered attending: their own schedule, availability, and swap requests",
    // schedule.view ONLY, and deliberately nothing else. An attending is faculty:
    // they see the clinic day they cover and act on their own assignments. They
    // are not a director and hold no volunteer-facing rights, so the Volunteer
    // role's learning.access (which pulls them into the course assignment surface)
    // would be wrong here.
    //
    // Assigned per-person (RoleAssignment.personId), never by kind: Track has no
    // faculty member, and there is no TermMembership to hang a kind-target grant
    // on. enableHubAccess in the schedule module is the only writer.
    grants: ["schedule.view"],
  },
  {
    name: "Volunteer Operations Manager",
    description: "Offboarding, IT support requests, and incident reports across the clinic",
    grants: ["volunteers.view", "volunteers.manage_offboarding", "support.manage_requests", "incidents.manage", "incidents.view_strikes"],
  },
];
