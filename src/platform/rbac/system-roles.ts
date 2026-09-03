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

/**
 * The role Faculty Relations holds. Named here rather than spelled out at each
 * use site so the roster, the reminder copy, and the seed cannot drift apart.
 */
export const FACULTY_RELATIONS_ROLE = "Faculty Relations Manager";

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
    // volunteers.view_directory_own_dept: mailing your own team should not mean
    // copying addresses out of the roster one at a time. The _own_dept half of
    // the pair, exactly like schedule.edit_own_dept: the Director role is
    // attached KIND-targeted, so permissionDepartmentIds resolves it to the
    // departments the person actually DIRECTS and the directory scopes itself
    // to that set. Someone who directs Nursing and volunteers in Triage gets
    // Nursing. Clinic-wide stays with volunteers.view_directory, which this
    // deliberately is not.
    grants: [
      "schedule.view",
      "volunteers.view",
      "learning.access",
      "incidents.view_strikes",
      "schedule.manage_attendance",
      "volunteers.view_directory_own_dept",
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
    // view_compliance is listed alongside manage_compliance rather than left
    // implicit. canViewAllCompliance already treats manage as implying view, so
    // this changes nothing functionally -- it exists so the Roles screen states
    // what the role can actually do, and so a later tightening of any read site
    // to view_compliance alone cannot silently lock the manager out.
    grants: ["volunteers.view", "volunteers.view_compliance", "volunteers.manage_compliance"],
  },
  {
    name: FACULTY_RELATIONS_ROLE,
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
  {
    name: "Executive Director",
    description: "Clinic-wide people directory: headcount by department and contact-list export",
    // Read-only on purpose. Seeing who is on the roster says nothing about
    // editing them, so this deliberately does NOT carry admin.manage_people --
    // an ED who also administers people gets that role stacked on top.
    //
    // volunteers.view rides along because the directory lives in the Volunteers
    // module: without it the role could open its own page but no other tab in
    // the module it sits in, which reads as a broken nav rather than a scope.
    grants: ["volunteers.view", "volunteers.view_directory"],
  },
];
