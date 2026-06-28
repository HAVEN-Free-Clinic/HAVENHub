import {
  CalendarDays,
  ClipboardList,
  GraduationCap,
  HeartHandshake,
  MessagesSquare,
  Send,
  Settings,
  Stethoscope,
  UserRoundPen,
  Users,
} from "lucide-react";
import type { ModuleManifest } from "./types";

/** The single wiring point for modules (spec §8). Hub tiles render from this. */
export const MODULES: ModuleManifest[] = [
  {
    id: "schedule",
    title: "Clinic Schedule",
    description: "Build and view department schedules, request swaps",
    icon: CalendarDays,
    accessPermission: "schedule.view",
    permissions: [
      "schedule.view",
      "schedule.edit_own_dept",
      "schedule.edit_all",
      "schedule.manage_requests",
    ],
    status: "active",
    nav: [
      { label: "My schedule", href: "/schedule" },
      { label: "Full schedule", href: "/schedule/full" },
      { label: "Builder", href: "/schedule/builder" },
      { label: "Attendings", href: "/schedule/attendings" },
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
    nav: [],
  },
  {
    id: "volunteers",
    title: "Volunteer Management",
    description: "Compliance, rosters, offboarding, Epic requests, disciplinary",
    icon: Users,
    accessPermission: "volunteers.view",
    permissions: [
      "volunteers.view",
      "volunteers.manage_compliance",
      "volunteers.manage_offboarding",
      "volunteers.manage_epic",
      "volunteers.issue_disciplinary",
    ],
    status: "active",
    nav: [
      // Compliance / Offboarding / Disciplinary gate on volunteers.view (= module access).
      { label: "Compliance", href: "/volunteers" },
      { label: "Master view", href: "/volunteers/master", permission: "volunteers.manage_compliance" },
      { label: "Offboarding", href: "/volunteers/offboarding" },
      { label: "Epic requests", href: "/volunteers/epic", permission: "volunteers.manage_epic" },
      { label: "Disciplinary", href: "/volunteers/disciplinary" },
    ],
  },
  {
    id: "clinic",
    title: "Clinic Tools",
    description: "Point-of-care tools for clinical volunteers",
    icon: Stethoscope,
    // No accessPermission: the After Visit Summary tool is open to any
    // onboarded signed-in volunteer for use during a visit (spec decision).
    permissions: [],
    status: "active",
    nav: [{ label: "After Visit Summary", href: "/clinic/avs" }],
  },
  {
    id: "admin",
    title: "Admin",
    description: "People, terms, roles, sync health, audit log",
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
      "admin.send_email_campaign",
      "admin.manage_settings",
      "admin.manage_departments",
      "admin.manage_subcommittees",
    ],
    status: "active",
    nav: [
      // Overview and ITCM gate on admin.access (= module access); the rest each
      // require a distinct sub-permission, mirrored here from the page gates.
      // Email and Notifications enforce admin.manage_sync (not the email perms).
      { label: "Overview", href: "/admin" },
      { label: "People", href: "/admin/people", permission: "admin.manage_people" },
      { label: "Terms", href: "/admin/terms", permission: "admin.manage_terms" },
      { label: "Roles", href: "/admin/roles", permission: "admin.manage_roles" },
      { label: "Departments", href: "/admin/departments", permission: "admin.manage_departments" },
      { label: "Subcommittees", href: "/admin/subcommittees", permission: "admin.manage_subcommittees" },
      { label: "Audit", href: "/admin/audit", permission: "admin.view_audit" },
      { label: "Sync", href: "/admin/sync", permission: "admin.manage_sync" },
      { label: "Email", href: "/admin/email", permission: "admin.manage_sync" },
      { label: "Notifications", href: "/admin/notifications", permission: "admin.manage_sync" },
      { label: "Settings", href: "/admin/settings", permission: "admin.manage_settings" },
      { label: "ITCM", href: "/admin/itcm" },
    ],
  },
  {
    id: "recruitment",
    title: "Recruitment",
    description: "Run recruitment cycles, build applications, review submissions",
    icon: ClipboardList,
    accessPermission: "recruitment.access",
    permissions: ["recruitment.access", "recruitment.manage_cycles", "recruitment.review", "recruitment.review_all"],
    status: "active",
    nav: [{ label: "Cycles", href: "/recruitment" }],
  },
  {
    id: "learning",
    title: "Learning",
    description: "Self-paced training courses assigned by department",
    icon: GraduationCap,
    accessPermission: "learning.access",
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
    id: "triage",
    title: "Triage",
    description: "Patient case coordination across departments",
    icon: MessagesSquare,
    accessPermission: "triage.access",
    permissions: ["triage.access"],
    status: "coming-soon",
    nav: [],
  },
  {
    id: "referrals",
    title: "Referrals",
    description: "Track outgoing patient referrals",
    icon: Send,
    accessPermission: "referrals.access",
    permissions: ["referrals.access"],
    status: "coming-soon",
    nav: [],
  },
  {
    id: "patient-trackers",
    title: "Patient Trackers",
    description: "Department patient tracking workflows",
    icon: HeartHandshake,
    accessPermission: "patient-trackers.access",
    permissions: ["patient-trackers.access"],
    status: "coming-soon",
    nav: [],
  },
];

export function getModule(id: string): ModuleManifest | undefined {
  return MODULES.find((m) => m.id === id);
}
