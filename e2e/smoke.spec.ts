import { expect, test } from "@playwright/test";
import { loginAs, type Role } from "./auth";

type RouteCase = {
  path: string;
  allowed: Role;
  denied?: Role;
  /**
   * Override the URL to assert after navigation for routes that immediately
   * redirect on success (e.g. /clinic -> /clinic/avs).
   */
  finalPath?: string;
};

// Each entry: the path to visit, the role that should reach the page, and an
// optional role that should be bounced. Admin is always a valid allowed role
// (holds *, exempt from the onboarding gate). For routes open to any
// authenticated person (/, /my-info, /notifications, /training, /clinic*,
// /learning, /schedule, /schedule/full) there is no meaningful denied role.
const ROUTES: RouteCase[] = [
  // Hub root: requirePersonSession only
  { path: "/", allowed: "admin" },

  // Admin module: requireModuleAccess("admin") = admin.access on the layout.
  // All sub-pages additionally check a finer permission; admin (*) passes both.
  // Volunteer has no admin.* grants and is denied at the layout.
  { path: "/admin", allowed: "admin", denied: "volunteer" },
  { path: "/admin/people", allowed: "admin", denied: "volunteer" },
  { path: "/admin/roles", allowed: "admin", denied: "volunteer" },
  { path: "/admin/terms", allowed: "admin", denied: "volunteer" },
  { path: "/admin/departments", allowed: "admin", denied: "volunteer" },
  { path: "/admin/subcommittees", allowed: "admin", denied: "volunteer" },
  { path: "/admin/audit", allowed: "admin", denied: "volunteer" },
  { path: "/admin/settings", allowed: "admin", denied: "volunteer" },
  { path: "/admin/email", allowed: "admin", denied: "volunteer" },
  { path: "/admin/email/campaigns", allowed: "admin", denied: "volunteer" },
  { path: "/admin/email/templates", allowed: "admin", denied: "volunteer" },
  { path: "/admin/itcm", allowed: "admin", denied: "volunteer" },
  { path: "/admin/notifications", allowed: "admin", denied: "volunteer" },

  // Clinic: no module accessPermission (open to any person session).
  // /clinic unconditionally redirects to /clinic/avs; use finalPath to reflect that.
  { path: "/clinic", allowed: "admin", finalPath: "/clinic/avs" },
  { path: "/clinic/avs", allowed: "admin" },

  // Learning: requireModuleAccess("learning") = learning.access.
  // All three seeded roles carry learning.access so the module root has no
  // meaningful denied case. Dashboard and Manage require elevated permissions.
  { path: "/learning", allowed: "admin" },
  { path: "/learning/dashboard", allowed: "admin", denied: "volunteer" },
  { path: "/learning/manage", allowed: "admin", denied: "volunteer" },

  // My Info: no module accessPermission (requirePersonSession only)
  { path: "/my-info", allowed: "admin" },

  // Notifications: requirePersonSession only
  { path: "/notifications", allowed: "admin" },

  // Recruitment: requireModuleAccess("recruitment") = recruitment.access.
  // Neither the Volunteer nor Director system role carries recruitment.access.
  { path: "/recruitment", allowed: "admin", denied: "volunteer" },

  // Schedule: requireModuleAccess("schedule") = schedule.view.
  // All three seeded roles carry schedule.view, so the list pages have no
  // meaningful denied case. Attendings gates on canManageAnyRhdDept (a
  // data-driven capability: admin has schedule.edit_all -> all depts including
  // RHD; volunteer manages nothing).
  { path: "/schedule", allowed: "admin" },
  { path: "/schedule/full", allowed: "admin" },
  { path: "/schedule/attendings", allowed: "admin", denied: "volunteer" },

  // Training: requirePersonSession only
  { path: "/training", allowed: "admin" },

  // Volunteers: requireModuleAccess("volunteers") = volunteers.view on the layout.
  // The Volunteer system role does NOT include volunteers.view; Director does.
  // All sub-pages are denied to volunteer at the layout level.
  { path: "/volunteers", allowed: "admin", denied: "volunteer" },
  { path: "/volunteers/master", allowed: "admin", denied: "volunteer" },
  { path: "/volunteers/offboarding", allowed: "admin", denied: "volunteer" },
  { path: "/volunteers/epic", allowed: "admin", denied: "volunteer" },
  { path: "/volunteers/disciplinary", allowed: "admin", denied: "volunteer" },
  { path: "/volunteers/spanish-review", allowed: "admin", denied: "volunteer" },
];

// ---------------------------------------------------------------------------
// Test loop
// ---------------------------------------------------------------------------

for (const r of ROUTES) {
  test(`smoke: ${r.path} loads for ${r.allowed}`, async ({ page }) => {
    await loginAs(page, r.allowed);
    const resp = await page.goto(r.path);
    expect(resp?.status(), `${r.path} HTTP status`).toBeLessThan(400);
    await expect(page).toHaveURL((url) => url.pathname === (r.finalPath ?? r.path));
    // Verify no Next.js error boundary was rendered.
    await expect(
      page.getByText(/Application error|Unhandled Runtime Error/i),
    ).toHaveCount(0);
  });

  if (r.denied) {
    test(`smoke: ${r.path} denies ${r.denied}`, async ({ page }) => {
      await loginAs(page, r.denied!);
      await page.goto(r.path);
      // The guard redirects away from the protected path. Acceptable landing
      // spots: /no-access (permission denied), /get-started (onboarding gate),
      // or / (hub fallback). The important invariant is that the user is NOT
      // left on the protected route.
      await page.waitForURL((url) => url.pathname !== r.path, { timeout: 10_000 });
      const deflected = new URL(page.url()).pathname;
      expect(
        deflected === "/no-access" ||
          deflected === "/" ||
          deflected.startsWith("/get-started"),
        `expected denial from ${r.path}, but landed on ${deflected}`,
      ).toBe(true);
    });
  }
}
