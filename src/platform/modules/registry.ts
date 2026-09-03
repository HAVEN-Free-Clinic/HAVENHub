import {
  CalendarDays,
  ClipboardList,
  GraduationCap,
  LifeBuoy,
  Megaphone,
  Settings,
  ShieldAlert,
  Stethoscope,
  UserRoundPen,
  Users,
} from "lucide-react";
import type { ModuleManifest } from "./types";

/** The single wiring point for modules (spec §8). Hub tiles render from this. */
export const MODULES: ModuleManifest[] = [
  {
    id: "schedule",
    title: "Schedule",
    description: "Build and view department schedules, request swaps",
    icon: CalendarDays,
    accessPermission: "schedule.view",
    permissions: [
      "schedule.view",
      "schedule.edit_own_dept",
      "schedule.edit_all",
      "schedule.manage_requests",
      // Deliberately unscoped (not department-scoped, unlike the permissions
      // above): the operational reality is one front-desk staffer marking
      // walk-ins present across every department, not per-department checks.
      "schedule.manage_attendance",
      // Also unscoped, for the same kind of reason: there is ONE attending
      // roster and ONE attending schedule for the whole clinic, maintained by
      // Faculty Relations. Attendings are not members of a department, so a
      // department-scoped grant could not express who may edit them.
      "schedule.manage_attendings",
      // Unscoped like the two above, and for the same kind of reason: there is
      // ONE weekly triage chat per preset for the whole clinic, created by an
      // Executive Director. A department-scoped grant could not express that.
      "schedule.manage_triage_chats",
    ],
    status: "active",
    nav: [
      { label: "My schedule", href: "/schedule" },
      // Data-driven: only meaningful on a clinic date, and schedule/layout.tsx
      // drops it otherwise. dynamicGate keeps it out of the global dropdown,
      // which cannot resolve "is today a clinic day".
      { label: "Check in", href: "/schedule/check-in", dynamicGate: true },
      { label: "Full schedule", href: "/schedule/full" },
      // Builder, Approvals and Attendings all gate on a data-driven capability
      // (managing a schedule department / an RHD department / at least one
      // request department) that no permission string can express, so
      // schedule/layout.tsx resolves each one and drops the tab itself. The
      // dynamicGate marker keeps them out of the global nav dropdown, which
      // cannot run those checks and would otherwise offer links to /no-access.
      { label: "Builder", href: "/schedule/builder", dynamicGate: true },
      {
        label: "Approvals",
        href: "/schedule/requests",
        // EITHER authority: schedule.manage_requests decides a department's
        // volunteer requests, schedule.manage_attendings decides the clinic-wide
        // attending ones. filterNavItems shows an item when the viewer holds ANY
        // listed permission, matching a page that admits on either.
        permission: ["schedule.manage_requests", "schedule.manage_attendings"],
        dynamicGate: true,
      },
      { label: "Attendings", href: "/schedule/attendings", dynamicGate: true },
      // Reference data for the roster above, so it lives beside it rather than in
      // Admin. Putting it under /admin would have made it unreachable by the one
      // role that owns attendings: Faculty Relations Manager holds
      // schedule.manage_attendings but not admin.access, so the Admin module's
      // accessPermission would have gated them out of their own configuration.
      //
      // A SIBLING href, not /schedule/attendings/specialties. ModuleNav's active
      // rule prefix-matches any href with more than one segment, so nesting a tab
      // under another tab's path lights BOTH of them up at once (and sends
      // scrollActiveTabIntoView to the wrong one, since it takes the first
      // aria-current match). No other module nests, which is why the rule has held
      // so far. Keep tab hrefs flat.
      {
        label: "Specialties",
        href: "/schedule/specialties",
        permission: "schedule.manage_attendings",
      },
      {
        label: "Triage chats",
        href: "/schedule/triage-chats",
        permission: "schedule.manage_triage_chats",
      },
      // Read-only view of the same schedule, for a WIDER audience than the
      // builder: anyone holding clinic-wide schedule rights runs a clinic day
      // and needs to look coverage up without being able to change it. Also
      // data-driven (schedule.edit_all OR schedule.manage_attendings), so the
      // layout resolves it and the global dropdown stays out of it.
      { label: "Coverage", href: "/schedule/coverage", dynamicGate: true },
    ],
  },
  {
    id: "my-info",
    title: "My Info",
    description: "Update your contact info and HIPAA compliance",
    icon: UserRoundPen,
    // No accessPermission: My Info is open to any signed-in matched person,
    // including alumni with no current term (spec decision).
    permissions: [],
    status: "active",
    personal: true,
    nav: [],
  },
  {
    id: "volunteers",
    title: "Volunteers",
    description: "Compliance, rosters, offboarding",
    icon: Users,
    accessPermission: "volunteers.view",
    // A Spanish-review reviewer is granted only volunteers.verify_spanish; it is
    // their sole page, so it also grants module access (the tile, the layout, and
    // the nav). Every other page still enforces its own permission.
    // An Executive Director holds volunteers.view_directory and, unless someone
    // stacks another role on them, nothing else in this module. Listing it here
    // too means the role opens the module on its own rather than depending on a
    // volunteers.view it happens to inherit from elsewhere.
    additionalAccessPermissions: [
      "volunteers.verify_spanish",
      "volunteers.view_directory",
      // The scoped half of the directory pair opens the module for the same
      // reason. A department director reaches it through volunteers.view
      // anyway, but a role that grants only the scoped directory must not be
      // admitted by accident of what else the holder happens to carry.
      "volunteers.view_directory_own_dept",
      // Same reasoning as view_directory: a role granting only the read half of
      // compliance must be able to open the module its pages live in.
      "volunteers.view_compliance",
    ],
    permissions: [
      "volunteers.view",
      // The clinic-wide compliance READ, split out of manage_compliance so a
      // role can see every member's status without also being able to attest
      // one. manage_compliance still implies it (platform/compliance/access.ts,
      // canViewAllCompliance) and remains the permission for verifying
      // certificates, entering completion dates, and managing EHS trainings.
      "volunteers.view_compliance",
      "volunteers.manage_compliance",
      "volunteers.manage_offboarding",
      "volunteers.verify_spanish",
      "volunteers.manage_board_attendance",
      // Clinic-wide: the directory answers "how many people does the clinic
      // have, and where", which a department-scoped grant cannot express.
      // Read-only -- it exposes headcount and contact details, never an edit.
      "volunteers.view_directory",
      // The department-scoped half of the same page, mirroring
      // schedule.edit_all / schedule.edit_own_dept. Held by the Director
      // baseline: a director gets the directory for the departments they
      // direct, so "mail every SCTM" is one Copy button rather than fourteen
      // addresses typed by hand. Resolved through permissionDepartmentIds, so
      // a directorship in one department never opens another.
      "volunteers.view_directory_own_dept",
    ],
    status: "active",
    nav: [
      // Compliance (/volunteers) and Offboarding both enforce requirePermission("volunteers.view"),
      // so gate their nav items on the same permission -- otherwise a Spanish-review-only
      // reviewer (admitted via additionalAccessPermissions) sees tabs that bounce to /no-access.
      { label: "Compliance", href: "/volunteers", permission: "volunteers.view" },
      // EITHER permission opens these two: both pages are clinic-wide compliance
      // READS that call requireAnyPermission with this exact pair. A view-only
      // holder gets the tables without the verify / date-entry / EHS-management
      // controls, which each page drops for them.
      {
        label: "Master view",
        href: "/volunteers/master",
        permission: ["volunteers.view_compliance", "volunteers.manage_compliance"],
      },
      // EITHER permission opens it, and the page itself decides how much of the
      // clinic the holder sees. Gating on the clinic-wide permission alone
      // would hide the tab from exactly the directors this scoped grant exists
      // to admit.
      {
        label: "Directory",
        href: "/volunteers/directory",
        permission: ["volunteers.view_directory", "volunteers.view_directory_own_dept"],
      },
      {
        label: "EHS training",
        href: "/volunteers/ehs",
        permission: ["volunteers.view_compliance", "volunteers.manage_compliance"],
      },
      // Label says Language; the href and permission keep their historical
      // spanish names because renaming a route breaks bookmarks and renaming a
      // permission means re-granting it in production. Neither is user-visible.
      { label: "Language review", href: "/volunteers/spanish-review", permission: "volunteers.verify_spanish" },
      { label: "Board meetings", href: "/volunteers/board-meetings", permission: "volunteers.manage_board_attendance" },
      { label: "Offboarding", href: "/volunteers/offboarding", permission: "volunteers.view" },
    ],
  },
  {
    id: "incidents",
    title: "Incidents",
    description: "Report a professional-standards concern; review reports and manage strikes",
    icon: ShieldAlert,
    // No accessPermission: open to any signed-in matched person so anyone can file a report.
    //
    // There is deliberately NO permission for "receives incident escalations".
    // incidents.escalation_recipient used to exist for exactly that, aimed at
    // medical directors -- but a permission can only be granted to a Person with
    // an account, and the advisors it was meant for are third parties with no Hub
    // account at all. It could never have reached them. Forwarding a report or a
    // strike outside the clinic is now an address a reviewer types, per matter
    // (see modules/incidents/services/forward.ts).
    permissions: ["incidents.manage", "incidents.view_strikes"],
    status: "active",
    nav: [
      { label: "Report a concern", href: "/incidents" },
      { label: "My reports", href: "/incidents/mine" },
      { label: "Review", href: "/incidents/review", permission: "incidents.manage" },
      { label: "Strikes", href: "/incidents/strikes", permission: "incidents.view_strikes" },
    ],
  },
  {
    id: "clinic",
    title: "Clinic",
    description: "Point-of-care tools for clinical volunteers",
    icon: Stethoscope,
    // Gated on a grantable clinic.access permission: point-of-care tools like
    // the After Visit Summary are admin-assigned, not open to every signed-in
    // person. No baseline system role carries it, so admins grant it per role
    // or per person. Platform Admin reaches it via the "*" wildcard.
    accessPermission: "clinic.access",
    permissions: ["clinic.access"],
    status: "active",
    nav: [{ label: "After Visit Summary", href: "/clinic/avs" }],
  },
  {
    id: "admin",
    title: "Admin",
    description: "People, terms, roles, audit log",
    icon: Settings,
    accessPermission: "admin.access",
    permissions: [
      "admin.access",
      "admin.manage_people",
      "admin.manage_terms",
      "admin.manage_roles",
      "admin.view_audit",
      "admin.manage_sync",
      "admin.manage_email_templates",
      "admin.manage_settings",
      "admin.manage_departments",
      "admin.manage_subcommittees",
      "admin.manage_roster",
    ],
    status: "active",
    nav: [
      // Overview gates on admin.access (= module access); the rest each
      // require a distinct sub-permission, mirrored here from the page gates.
      // Email and Notifications enforce admin.manage_sync (not the email perms).
      { label: "Overview", href: "/admin" },
      { label: "People", href: "/admin/people", permission: "admin.manage_people" },
      { label: "Terms", href: "/admin/terms", permission: "admin.manage_terms" },
      { label: "Roles", href: "/admin/roles", permission: "admin.manage_roles" },
      { label: "Departments", href: "/admin/departments", permission: "admin.manage_departments" },
      { label: "Subcommittees", href: "/admin/subcommittees", permission: "admin.manage_subcommittees" },
      { label: "Onboarding contract", href: "/admin/contract", permission: "admin.manage_settings" },
      { label: "Audit", href: "/admin/audit", permission: "admin.view_audit" },
      { label: "Email", href: "/admin/email", permission: "admin.manage_sync" },
      { label: "Notifications", href: "/admin/notifications", permission: "admin.manage_sync" },
      { label: "Settings", href: "/admin/settings", permission: "admin.manage_settings" },
    ],
  },
  {
    id: "outreach",
    title: "Outreach",
    description: "Send targeted email campaigns to a filtered audience",
    icon: Megaphone,
    accessPermission: "outreach.access",
    // A scoped sender holds outreach.send without outreach.access, and an admin
    // may hold only manage_scopes. Both must still reach the module.
    additionalAccessPermissions: ["outreach.send", "outreach.send_unrestricted", "outreach.manage_scopes"],
    permissions: [
      "outreach.access",
      // Compose and send, bounded to the audience scopes granted to the sender.
      "outreach.send",
      // Strictly stronger than outreach.send: may send with no scope at all.
      // This is what admin.send_email_campaign used to mean.
      "outreach.send_unrestricted",
      "outreach.manage_scopes",
    ],
    status: "active",
    nav: [
      // Campaigns/page.tsx enforces requireAnyPermission(["outreach.send",
      // "outreach.send_unrestricted"]), so gate the tab on the same pair --
      // otherwise a manage_scopes-only holder (admitted via
      // additionalAccessPermissions) sees a tab that bounces to /no-access.
      { label: "Campaigns", href: "/outreach/campaigns", permission: ["outreach.send", "outreach.send_unrestricted"] },
      { label: "Audience scopes", href: "/outreach/scopes", permission: "outreach.manage_scopes" },
      // Same gate as the page (see the comment at the top of identities/page.tsx
      // for why issuing an address reuses manage_scopes rather than minting a
      // fourth permission).
      { label: "Sending identities", href: "/outreach/identities", permission: "outreach.manage_scopes" },
    ],
  },
  {
    id: "recruitment",
    title: "Recruitment",
    description: "Run recruitment cycles, build applications, review submissions",
    icon: ClipboardList,
    accessPermission: "recruitment.access",
    // Committee scorers hold recruitment.score but not recruitment.access; this
    // surfaces the tile + nav tab for them without granting anything new (each
    // page still enforces its own permission).
    additionalAccessPermissions: ["recruitment.score"],
    // recruitment.record_attendance is deliberately UNSCOPED, like
    // schedule.manage_attendance above and for the same operational reason: one
    // person works the door at a training or info session and marks everybody
    // present, including walk-ups who have no hub record at all. A
    // department-scoped grant cannot express that. Holders of manage_cycles or
    // review_all already act clinic-wide and get the same reach without it; a
    // department-scoped director keeps exactly the narrower authority they had
    // before events existed (their own departments' members, no walk-ups).
    permissions: [
      "recruitment.access",
      "recruitment.manage_cycles",
      "recruitment.review_all",
      "recruitment.score",
      "recruitment.record_attendance",
    ],
    status: "active",
    nav: [
      { label: "Cycles", href: "/recruitment" },
      // The real gate is "may record attendance on ANY scope", which stacks a
      // permission check on a data-driven one (a director's review scope), so the
      // module layout resolves it and drops the tab itself.
      { label: "Events", href: "/recruitment/events", dynamicGate: true },
      // /recruitment/history hard-gates on recruitment.access (no committee-scorer
      // carve-out like the Cycles index has), so gate the tab the same way --
      // otherwise a score-only reviewer (admitted via additionalAccessPermissions
      // above) sees a tab that bounces to /no-access.
      { label: "History", href: "/recruitment/history", permission: "recruitment.access" },
    ],
  },
  {
    id: "learning",
    title: "Learning",
    description: "Self-paced training courses assigned by department",
    icon: GraduationCap,
    accessPermission: "learning.access",
    // A Learning Coordinator / Compliance role may hold only manage_courses or
    // view_progress. Admit them to the module (the tile, the layout, the nav) so
    // the granted permission isn't dead; each page still enforces its own gate,
    // and the "My courses" landing page gates on module access (requireModuleAccess),
    // so it stays reachable for them. Mirrors recruitment.score above.
    additionalAccessPermissions: ["learning.manage_courses", "learning.view_progress"],
    permissions: ["learning.access", "learning.manage_courses", "learning.view_progress"],
    status: "active",
    nav: [
      // My courses gates on learning.access (= module access).
      { label: "My courses", href: "/learning" },
      { label: "Manage courses", href: "/learning/manage", permission: "learning.manage_courses" },
      { label: "Completion", href: "/learning/dashboard", permission: "learning.view_progress" },
    ],
  },
  {
    id: "support",
    title: "Support",
    description: "Submit and track IT and Epic access requests",
    icon: LifeBuoy,
    // No accessPermission: open to any signed-in matched person (like my-info),
    // so anyone can submit. Manager tabs gate on support.manage_requests.
    //
    // support.view_all_requests is the read-only half of manage_requests: it
    // opens the cross-clinic queue to someone who needs to answer "where is my
    // request?" without being able to work a ticket. It reaches ONLY the "All
    // requests" tab -- never Epic / YNHH tools, which submits real access
    // requests.
    permissions: ["support.manage_requests", "support.view_all_requests"],
    status: "active",
    nav: [
      { label: "My requests", href: "/support" },
      { label: "Submit a request", href: "/support/new" },
      {
        label: "All requests",
        href: "/support/all",
        permission: ["support.manage_requests", "support.view_all_requests"],
      },
      { label: "Epic / YNHH tools", href: "/support/epic", permission: "support.manage_requests" },
    ],
  },
];

export function getModule(id: string): ModuleManifest | undefined {
  return MODULES.find((m) => m.id === id);
}
