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
// authenticated person (/, /my-info, /notifications, /training, /learning,
// /schedule, /schedule/full) there is no meaningful denied role.
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
  { path: "/support/epic", allowed: "admin", denied: "volunteer" },
  { path: "/admin/notifications", allowed: "admin", denied: "volunteer" },

  // Clinic: requireModuleAccess("clinic") = clinic.access. No baseline system
  // role carries it, so the Volunteer role is denied at the layout. /clinic
  // unconditionally redirects to /clinic/avs; use finalPath to reflect that.
  { path: "/clinic", allowed: "admin", denied: "volunteer", finalPath: "/clinic/avs" },
  { path: "/clinic/avs", allowed: "admin", denied: "volunteer" },

  // Incidents: no module accessPermission (open to any signed-in matched
  // person so anyone can file a report). The Strikes sub-page gates on
  // incidents.view_strikes at the page level; the Volunteer system role does
  // not hold it (only Director and Volunteer Operations Manager do), so
  // volunteer is denied there despite the module layout being open.
  { path: "/incidents/strikes", allowed: "admin", denied: "volunteer" },

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
  // meaningful denied case. Attendings is the exception: it maintains the
  // roster and books coverage, so it gates on managing a service line and a
  // volunteer is denied. What a volunteer needs from it -- who is attending on
  // the shift THEY work -- is on /schedule instead.
  //
  // Coverage is the read-only twin of Attendings on a wider gate
  // (schedule.edit_all OR schedule.manage_attendings). A volunteer holds
  // neither, so it is denied to them just the same -- the point of the wider
  // gate is the directors between those two, not the whole clinic.
  { path: "/schedule", allowed: "admin" },
  { path: "/schedule/full", allowed: "admin" },
  { path: "/schedule/attendings", allowed: "admin", denied: "volunteer" },
  { path: "/schedule/coverage", allowed: "admin", denied: "volunteer" },

  // Training: requirePersonSession only
  { path: "/training", allowed: "admin" },

  // Volunteers: requireModuleAccess("volunteers") = volunteers.view on the layout.
  // The Volunteer system role does NOT include volunteers.view; Director does.
  // All sub-pages are denied to volunteer at the layout level.
  { path: "/volunteers", allowed: "admin", denied: "volunteer" },
  { path: "/volunteers/master", allowed: "admin", denied: "volunteer" },
  { path: "/volunteers/offboarding", allowed: "admin", denied: "volunteer" },
  { path: "/volunteers/spanish-review", allowed: "admin", denied: "volunteer" },
];

// ---------------------------------------------------------------------------
// Test loop
// ---------------------------------------------------------------------------

/**
 * What our own error boundaries render (audit 14, TSI-01).
 *
 * A server component that throws inside the (app) tree does NOT fail the
 * request: Next streams the shell, swaps in src/app/(app)/error.tsx, and the
 * response is still 200. So `status < 400` is true of a completely broken page,
 * and the content assertion is the only thing here with teeth.
 *
 * That assertion used to look for /Application error|Unhandled Runtime Error/.
 * Neither string can ever appear in this app: "Application error: a client-side
 * exception has occurred" is Next's own fallback for apps that ship NO
 * global-error.tsx (we have one, and it renders "Something went wrong"), and
 * "Unhandled Runtime Error" was the pre-15 dev overlay title. Every one of the
 * 32 routes below was therefore guarded by the status code alone.
 *
 * "Something went wrong" is the shared heading of (app)/error.tsx,
 * global-error.tsx and get-started/error.tsx, so one string covers all three.
 */
const ERROR_BOUNDARY_HEADING = /^Something went wrong$/;

for (const r of ROUTES) {
  test(`smoke: ${r.path} loads for ${r.allowed}`, async ({ page }) => {
    await loginAs(page, r.allowed);
    const resp = await page.goto(r.path);
    expect(resp?.status(), `${r.path} HTTP status`).toBeLessThan(400);
    await expect(page).toHaveURL((url) => url.pathname === (r.finalPath ?? r.path));

    // Positive first: wait for the page body to actually paint something. This
    // is also what makes the negative assertion below meaningful -- checking for
    // the absence of an error heading before anything has rendered would pass
    // on a page that goes on to render one a tick later.
    const main = page.locator("main#main-content");
    await expect(main).toBeVisible();
    expect((await main.innerText()).trim().length, `${r.path} rendered an empty page body`)
      .toBeGreaterThan(0);

    await expect(
      page.getByRole("heading", { name: ERROR_BOUNDARY_HEADING }),
      `${r.path} rendered an error boundary with an HTTP ${resp?.status()}`,
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
