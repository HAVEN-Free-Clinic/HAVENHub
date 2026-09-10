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

/**
 * The single wiring point for modules (spec §8). Hub tiles render from this.
 *
 * Rule for every `nav` item below, enforced by nav-title.guard.test.ts: the
 * label IS the H1 of the page it points at (or the module-qualified form of
 * it, "<module title> <label>", which search/match.ts already composes). Two
 * surfaces make that load-bearing. buildBreadcrumbs in
 * platform/ui/breadcrumb-trail.ts renders this label as the current crumb, so
 * a divergence prints two names for one page a single line apart. And
 * matchPages in platform/search/match.ts scores only the label, so a page
 * whose H1 shares no words with its label cannot be found in Cmd+K by the
 * name printed on it.
 *
 * Which side moves is a width question, because the module tab row scrolls:
 * rows with headroom promote the longer name into the label, rows already at
 * their limit (Schedule, Volunteers, Admin) keep the label and shorten the
 * H1, leaving the dropped qualifier in the page description.
 *
 * Carve-out at a module ROOT (a nav href equal to the module href): the crumb
 * there is the MODULE title, not the label, so aligning label and H1 buys the
 * Cmd+K and dropdown axis only.
 */
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
      // Folded under My schedule: a tab that exists about 30 days a year. /schedule
      // and the dashboard both carry a check-in banner on a clinic day instead.
      { label: "Check in", href: "/schedule/check-in", dynamicGate: true, underTab: "/schedule" },
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
        // NO `permission`, deliberately. The page admits on
        // `manageableRequestDepartmentIds(...).length > 0 ||
        // canManageAttendingRequests(...)`, and the first of those unions
        // `manageableDepartmentIds`, which is satisfied by an ACTIVE DIRECTOR
        // TermMembership and no permission at all. So a plain department
        // director can open this page.
        //
        // The item used to carry
        // `["schedule.manage_requests", "schedule.manage_attendings"]`, neither
        // of which the shipped Director role grants. filterNavItems runs BEFORE
        // the layout's data-driven `canApprove` clause, so that permission
        // filter dropped the tab for every director and `canApprove` -- which
        // can only narrow -- never got the chance to restore it. Directors were
        // emailed a link to a page with no route back to it: the daily reminder
        // and the dashboard card both use the same wide, permission-free
        // authority the page does, so they offered a destination the nav denied.
        //
        // `dynamicGate` is what keeps this honest without a permission string:
        // the global nav drops the item unless a caller resolves the gate
        // (resolvedScheduleNavHrefs computes the same canApprove), and the
        // schedule layout applies canApprove to the tab row. A viewer who can
        // approve nothing still never sees it.
        dynamicGate: true,
      },
      { label: "Attendings", href: "/schedule/attendings", dynamicGate: true },
      // The credentialing tracker for the roster above: same gate
      // (canManageAttendings), so the same dynamicGate treatment. It had no tab,
      // no dropdown entry and no Cmd+K hit, reachable only from a button on
      // /schedule/attendings -- and it is where every new attending is tracked.
      //
      // Folded under Attendings (see ModuleNavItem.underTab): it keeps the
      // dropdown entry and Cmd+K hit that fix gave it, and its button on the
      // roster, without holding a permanent tab of its own.
      { label: "Credentialing", href: "/schedule/attendings/credentialing", dynamicGate: true, underTab: "/schedule/attendings" },
      // Reference data for the roster above, so it lives beside it rather than in
      // Admin. Putting it under /admin would have made it unreachable by the one
      // role that owns attendings: Faculty Relations Manager holds
      // schedule.manage_attendings but not admin.access, so the Admin module's
      // accessPermission would have gated them out of their own configuration.
      //
      // A SIBLING href, not /schedule/attendings/specialties -- but now by
      // meaning rather than by necessity. Specialties is reference data for the
      // roster, not a page inside it. (Nesting itself is safe again: ModuleNav
      // marks only the most specific matching tab, so Credentialing below can
      // live under /schedule/attendings without lighting Attendings up too.)
      {
        label: "Specialties",
        href: "/schedule/specialties",
        permission: "schedule.manage_attendings",
        // Reference data for the roster, linked from it: folded under Attendings.
        underTab: "/schedule/attendings",
      },
      {
        label: "Triage chats",
        href: "/schedule/triage-chats",
        permission: "schedule.manage_triage_chats",
        // A weekly action rather than a place: folded under Full schedule, which
        // carries a "Triage chats" button for the people who can use it.
        underTab: "/schedule/full",
      },
      // Read-only view of the same schedule, for a WIDER audience than the
      // builder: anyone holding clinic-wide schedule rights runs a clinic day
      // and needs to look coverage up without being able to change it. Also
      // data-driven (schedule.edit_all OR schedule.manage_attendings), so the
      // layout resolves it and the global dropdown stays out of it.
      //
      // Folded under Attendings: it is the read-only view of the same grid, and
      // Attendings links to it. (Its wider audience, schedule.edit_all, is held
      // by no system role today; such a viewer would still reach it from the
      // dropdown and Cmd+K, just with no tab lit.)
      { label: "Coverage", href: "/schedule/coverage", dynamicGate: true, underTab: "/schedule/attendings" },
    ],
  },
  {
    id: "my-info",
    title: "My info",
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
      // Department-scoped like the directory pair above, and held by the same
      // Director baseline: a volunteer accepted elsewhere can offer to also
      // serve VADM or INTP, and the receiving department decides. Resolved
      // through permissionDepartmentIds, so a directorship in one department
      // never shows another department's offers.
      "volunteers.manage_dual_roles",
    ],
    status: "active",
    nav: [
      // The one compliance roster. ANY of the three opens it, mirroring the page:
      // the clinic-wide pair sees every member, volunteers.view (a director) sees
      // the departments they direct. It was two tabs -- "Compliance" for
      // directors and "Master view" for the clinic-wide pair -- over the same
      // people, and they disagreed (the directors' copy dropped Learning). The
      // old /volunteers/master URL now redirects here. A Spanish-review-only
      // reviewer holds none of the three, so still sees no tab that would bounce.
      {
        label: "Compliance",
        href: "/volunteers",
        permission: ["volunteers.view", "volunteers.view_compliance", "volunteers.manage_compliance"],
      },
      // EITHER permission opens EHS training: a clinic-wide compliance READ that
      // calls requireAnyPermission with this exact pair. A view-only holder gets
      // the table without the verify / date-entry / EHS-management controls.
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
      // Maintaining the list of trainings, as opposed to reading who has done
      // them. It once had no nav entry at all, so a compliance manager had to
      // remember that the button lives on /volunteers/ehs. The entry keeps it in
      // the dropdown and Cmd+K; folding it under EHS training keeps it out of
      // the tab row, where it was a second tab for the same subject. Its
      // permission implies EHS training's, so the parent is always drawn.
      {
        label: "Manage trainings",
        href: "/volunteers/ehs/manage",
        permission: "volunteers.manage_compliance",
        underTab: "/volunteers/ehs",
      },
      // Label says Language; the href and permission keep their historical
      // spanish names because renaming a route breaks bookmarks and renaming a
      // permission means re-granting it in production. Neither is user-visible.
      { label: "Language review", href: "/volunteers/spanish-review", permission: "volunteers.verify_spanish" },
      // Every director holds volunteers.manage_dual_roles, but only the two
      // departments that ask the dual-role question on the application can ever
      // have a queue. Gating on the permission alone would put a tab in front of
      // every director in the clinic that leads to an empty page for nearly all
      // of them -- and widen a nav row that is already at its limit. The real
      // gate is "directs a department someone can offer to", which no permission
      // string expresses, so the layout resolves it.
      {
        label: "Dual roles",
        href: "/volunteers/dual-roles",
        permission: "volunteers.manage_dual_roles",
        dynamicGate: true,
      },
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
      // The form is at /incidents/new, not the module root: the root is where
      // every up-link in the module lands, and landing in a blank concern
      // report is not where a reviewer stepping back from a case wants to be.
      { label: "Report a concern", href: "/incidents/new" },
      { label: "My reports", href: "/incidents/mine" },
      { label: "Review queue", href: "/incidents/review", permission: "incidents.manage" },
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
    // A role granted only the template permission must still open the module,
    // or the two pages it exists to grant stay unreachable. Same shape as
    // outreach's manage_scopes and recruitment's score.
    additionalAccessPermissions: ["admin.manage_email_templates"],
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
      // admin.manage_email_templates granted these two pages and no route to
      // them: the only way in was a text link on /admin/email, which is gated
      // on a DIFFERENT permission (admin.manage_sync). A holder of the template
      // permission alone was locked out of the pages it exists to grant.
      {
        label: "Email templates",
        href: "/admin/email/templates",
        permission: "admin.manage_email_templates",
      },
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
      { label: "Email campaigns", href: "/outreach/campaigns", permission: ["outreach.send", "outreach.send_unrestricted"] },
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
      { label: "Attendance events", href: "/recruitment/events", dynamicGate: true },
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
      { label: "Course completion", href: "/learning/dashboard", permission: "learning.view_progress" },
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
    // requests" tab -- never Epic requests, which submits real access
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
      { label: "Epic requests", href: "/support/epic", permission: "support.manage_requests" },
    ],
  },
];

export function getModule(id: string): ModuleManifest | undefined {
  return MODULES.find((m) => m.id === id);
}
