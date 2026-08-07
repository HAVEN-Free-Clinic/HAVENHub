import { expect, test } from "@playwright/test";
import { devLogin } from "./auth";
import {
  seedTodayClinicDate,
  seedOnboardedVolunteer,
  seedAttendance,
} from "./fixtures";

// Must match the seeded clinic.checkIn* settings. The test DB never has a
// Setting row for these (prisma/seed.ts writes none), so they resolve to the
// env defaults in src/platform/config.ts: latitude 41.3025, longitude
// -72.937, radius 250m, max accuracy 200m. Boston is ~100 miles away, far
// outside that radius regardless of GPS error.
const CLINIC = { latitude: 41.3025, longitude: -72.937 };
const BOSTON = { latitude: 42.3601, longitude: -71.0589 };

test.describe("clinic check-in", () => {
  // Playwright grants geolocation permission and pins a fixed position per
  // browser context, which is what makes the geofence genuinely exercised
  // here rather than only mocked at the unit boundary.
  test.use({ permissions: ["geolocation"] });

  test("an assigned volunteer at the clinic can check in", async ({ page, context }) => {
    const clinic = await seedTodayClinicDate();
    const volunteer = await seedOnboardedVolunteer("VADM", {
      assignment: { clinicDate: clinic.clinicDate },
    });
    try {
      await context.setGeolocation(CLINIC);
      await devLogin(page, volunteer.email);
      await page.goto("/schedule/check-in");

      await page.getByRole("button", { name: "Check in", exact: true }).click();
      await expect(page.getByRole("heading", { name: "You are checked in", exact: true })).toBeVisible({
        timeout: 10_000,
      });
    } finally {
      await volunteer.cleanup();
      await clinic.cleanup();
    }
  });

  test("a volunteer far away is refused and pointed at a director", async ({ page, context }) => {
    const clinic = await seedTodayClinicDate();
    const volunteer = await seedOnboardedVolunteer("VADM", {
      assignment: { clinicDate: clinic.clinicDate },
    });
    try {
      await context.setGeolocation(BOSTON);
      await devLogin(page, volunteer.email);
      await page.goto("/schedule/check-in");

      await page.getByRole("button", { name: "Check in", exact: true }).click();

      // The failure copy (check-in-panel.tsx FAILURE_COPY.OUT_OF_RANGE) renders
      // in the one role="status" alert on this page. Anchored on the phrase
      // unique to OUT_OF_RANGE, not a loose substring: this suite has been bitten
      // before by a badge/text match colliding with unrelated copy elsewhere.
      await expect(page.getByRole("status")).toContainText("You do not appear to be at the clinic", {
        timeout: 10_000,
      });
      await expect(page.getByRole("heading", { name: "You are checked in", exact: true })).toHaveCount(0);
    } finally {
      await volunteer.cleanup();
      await clinic.cleanup();
    }
  });

  test("a director can mark someone present from the full schedule", async ({ page }) => {
    const clinic = await seedTodayClinicDate();
    const volunteer = await seedOnboardedVolunteer("VADM", {
      assignment: { clinicDate: clinic.clinicDate },
    });
    try {
      await devLogin(page, "j.carney@yale.edu"); // Platform Admin: holds "*", incl. schedule.manage_attendance
      await page.goto(`/schedule/full?date=${clinic.todayKey}`);

      const row = page.locator("li").filter({ has: page.getByText(volunteer.person.name, { exact: true }) });
      await expect(row).toBeVisible();
      await row.getByRole("button", { name: "Mark present", exact: true }).click();

      await expect(row.getByText("Here", { exact: true })).toBeVisible({ timeout: 10_000 });
      await expect(row.getByRole("button", { name: "Mark present", exact: true })).toHaveCount(0);
    } finally {
      await volunteer.cleanup();
      await clinic.cleanup();
    }
  });

  // ---------------------------------------------------------------------
  // Gap 1: an unassigned person must not see the dashboard's check-in card.
  // src/app/(app)/page.tsx: clinicToday = checkIn.clinicDate !== null &&
  // checkIn.assignmentCount > 0. Dropping the assignmentCount clause would
  // show this exact person a card that dead-ends on /schedule/check-in's
  // NOT_ASSIGNED refusal -- the dead-end-result regression this codebase has
  // shipped four times, per the nav IA program notes.
  // ---------------------------------------------------------------------
  test("an unassigned person does not see the check-in card, and would dead-end if they tried it anyway", async ({
    page,
    context,
  }) => {
    // This test cold-compiles two routes ("/" and "/schedule/check-in") on top of
    // the dev-login round trip; the default 30s budget has been observed to run
    // out on a cold Next.js dev-server compile, which would abort the finally
    // block mid-cleanup and leak the seeded clinic date. Longer budget, same as
    // schedule.spec.ts's own multi-navigation test.
    test.setTimeout(60_000);
    const clinic = await seedTodayClinicDate();
    const volunteer = await seedOnboardedVolunteer("VADM"); // no assignment
    try {
      await devLogin(page, volunteer.email);
      await page.goto("/");
      // Sanity that the dashboard actually rendered (not stuck on a gate/error),
      // so the missing-card assertion below isn't a false pass from a blank page.
      await expect(page.getByRole("heading", { name: "Modules", exact: true })).toBeVisible();
      // NOT getByRole("link", { name: "Clinic check-in" }): the card renders
      // label and sub as sibling <span>s inside one <Link> ("Clinic check-in" +
      // "Check in for today"), and a link's accessible name concatenates every
      // descendant text node, so the real accessible name is "Clinic check-in
      // Check in for today" and an exact-match role locator on just the label
      // can never match, present or not. getByText matches the label <span>'s
      // own text directly, which is exactly "Clinic check-in".
      await expect(page.getByText("Clinic check-in", { exact: true })).toHaveCount(0);

      // The dead end the card would otherwise walk them into: check-in still
      // refuses with NOT_ASSIGNED even though today is a clinic day.
      await context.setGeolocation(CLINIC);
      await page.goto("/schedule/check-in");
      await page.getByRole("button", { name: "Check in", exact: true }).click();
      await expect(page.getByRole("status")).toContainText("You are not on the schedule for today", {
        timeout: 10_000,
      });
    } finally {
      await volunteer.cleanup();
      await clinic.cleanup();
    }
  });

  // ---------------------------------------------------------------------
  // Gap 2: a viewer without schedule.manage_attendance must see NO attendance
  // state at all on /schedule/full -- not just missing buttons, but no "Here"
  // badge either. A peer-visible attendance column would broadcast who did
  // not show up, which is deliberately not shown to anyone but a director.
  // ---------------------------------------------------------------------
  test("a viewer without schedule.manage_attendance sees no attendance state on the full schedule", async ({
    page,
  }) => {
    const clinic = await seedTodayClinicDate();
    const present = await seedOnboardedVolunteer("VADM", { assignment: { clinicDate: clinic.clinicDate } });
    const absent = await seedOnboardedVolunteer("VADM", { assignment: { clinicDate: clinic.clinicDate } });
    const viewer = await seedOnboardedVolunteer("VADM"); // schedule.view only, no manage_attendance
    try {
      await seedAttendance(clinic.termId, clinic.clinicDate, present.person.id);

      // Contrast check first: a director on the SAME page sees the real state,
      // so the viewer assertions below can't pass merely because attendance
      // never renders for anyone.
      await devLogin(page, "j.carney@yale.edu");
      await page.goto(`/schedule/full?date=${clinic.todayKey}`);
      const presentRowAsDirector = page
        .locator("li")
        .filter({ has: page.getByText(present.person.name, { exact: true }) });
      const absentRowAsDirector = page
        .locator("li")
        .filter({ has: page.getByText(absent.person.name, { exact: true }) });
      await expect(presentRowAsDirector.getByText("Here", { exact: true })).toBeVisible();
      // Also proves the "Undo" locator used in the viewer's absence check below
      // CAN match a real element: undo only renders alongside "Here" on today's
      // date, so without this the toHaveCount(0) for "Undo" later would pass
      // vacuously if that locator were ever wrong, the same class of bug as the
      // dashboard-card locator this test file previously got flagged for.
      await expect(presentRowAsDirector.getByRole("button", { name: "Undo", exact: true })).toBeVisible();
      await expect(absentRowAsDirector.getByRole("button", { name: "Mark present", exact: true })).toBeVisible();

      // Switch to a plain volunteer: same page, same date, no manage_attendance.
      await page.context().clearCookies();
      await devLogin(page, viewer.email);
      await page.goto(`/schedule/full?date=${clinic.todayKey}`);

      // The roster itself must still render (this isn't a false pass from an
      // empty/blocked page)...
      await expect(page.getByText(present.person.name, { exact: true })).toBeVisible();
      await expect(page.getByText(absent.person.name, { exact: true })).toBeVisible();
      // ...but with no "Here" badge for the person who checked in, no "Mark
      // present" button for the person who hasn't, and no "Undo" either.
      await expect(page.getByText("Here", { exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Mark present", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Undo", exact: true })).toHaveCount(0);
    } finally {
      await Promise.all([present.cleanup(), absent.cleanup(), viewer.cleanup()]);
      await clinic.cleanup();
    }
  });
});
