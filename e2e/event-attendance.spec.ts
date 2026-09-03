import { expect, test } from "@playwright/test";
import { devLogin } from "./auth";
import { prisma } from "./fixtures";

test.setTimeout(120_000);

/**
 * The kiosk end to end: create an info session, check in a walk-up who has no
 * hub record, and see the attendance land on the event.
 *
 * A walk-up is the case worth driving through a browser. The service tests
 * (attendance-events.test.ts) cover the training bridge, the authority matrix
 * and the nudge stream far more cheaply than a browser can; what only the real
 * UI can prove is that the search-and-tap screen wires its client component,
 * bound server action and result rendering together at all -- and the walk-up
 * form needs no seeded roster to do it.
 *
 * An INFO_SESSION (not a TRAINING) on purpose: a training check-in completes
 * training for whoever it touches, and this test runs against the shared dev
 * database alongside other specs.
 */
test("event attendance: create an info session and check in a walk-up", async ({ page }) => {
  await devLogin(page, "j.carney@yale.edu");

  const title = `Info Session E2E ${Date.now()}`;
  const email = `walkup-${Date.now()}@yale.edu`;

  // --- Create the event ---
  await page.goto("/recruitment/events");
  await expect(page.getByRole("heading", { name: "Attendance events" })).toBeVisible();

  const createForm = page.locator('form:has(button:has-text("Create event"))');
  await createForm.locator('input[name="title"]').fill(title);
  await createForm.locator('select[name="kind"]').selectOption("INFO_SESSION");
  await createForm.locator('input[name="startsAt"]').fill("2026-09-03T18:00");
  await createForm.locator('input[name="location"]').fill("SHM L110");
  await createForm.locator('button:has-text("Create event")').click();

  // createEventAction redirects straight to the new event.
  await page.waitForURL((url) => /\/recruitment\/events\/[^/]+$/.test(url.pathname));
  const eventId = page.url().split("/events/")[1].split("?")[0];
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(page.getByText("Nobody checked in yet.")).toBeVisible();

  // --- Check in a walk-up from the kiosk ---
  await page.goto(`/recruitment/events/${eventId}/check-in`);
  await expect(page.getByRole("heading", { name: `Check in: ${title}` })).toBeVisible();

  await page.getByRole("button", { name: "Add someone not in the hub" }).click();
  await page.getByLabel("Attendee name").fill("Walk Up Tester");
  await page.getByLabel("Attendee email").fill(email);
  // The walk-up submit stays disabled until both fields look valid, so this
  // click also asserts the client-side readiness check let it through.
  await page.getByRole("button", { name: "Check in" }).click();

  // The kiosk never navigates: the outcome appears in its result line, and the
  // server's checked-in list refreshes underneath it. Scoped to the list to
  // avoid matching both (the ambiguity that caught the duplicate-render bug).
  await expect(page.getByRole("listitem").filter({ hasText: "Walk Up Tester" })).toBeVisible({
    timeout: 15000,
  });
  await expect(page.getByText("checked in, onboarding outstanding")).toBeVisible();

  // --- The attendance is on the event, unlinked ---
  await page.goto(`/recruitment/events/${eventId}`);
  await expect(page.getByText("Walk Up Tester")).toBeVisible();
  await expect(page.getByText(email)).toBeVisible();
  await expect(page.getByText("Not linked to a person")).toBeVisible();

  // Cleanup: the event and its attendance are this test's own rows. Deleting the
  // event cascades to the attendance.
  await prisma.attendanceEvent.delete({ where: { id: eventId } });
});
