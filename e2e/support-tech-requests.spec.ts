import { expect, test } from "@playwright/test";
import { devLogin } from "./auth";
import { tag } from "./fixtures";

/**
 * IT Support module: submit, track, comment (public/internal), manager
 * actions, and Epic promotion.
 *
 * Personas (matching the rest of the e2e suite):
 *   - Submitter: dev.volunteer@yale.edu -- a plain ACTIVE volunteer, already
 *     cleared past the onboarding gate by the seed (phone + verified HIPAA
 *     cert), so requireModuleAccess("support") lets them straight through to
 *     /support/*. Any signed-in person may submit/track (no permission
 *     required), so this is the natural submitter identity used throughout
 *     the rest of the suite (my-info.spec.ts, volunteers.spec.ts, schedule.spec.ts).
 *   - Manager: j.carney@yale.edu -- Platform Admin ("*"), which covers
 *     support.manage_requests. Matches every other manager-persona test in
 *     this suite.
 *
 * Each test switches personas with page.context().clearCookies() before a
 * second devLogin (same pattern as schedule.spec.ts's "Request round trip"
 * test) -- a live session cookie makes /login redirect away before the
 * dev-login form renders.
 *
 * Selector note: form fields use the shared Field wrapper, whose required
 * marker (" *") is part of the label text, so getByLabel is used WITHOUT
 * { exact: true } (a substring match on the field name).
 *
 * Tickets/comments/Epic requests created here are not cleaned up: they carry
 * no FK dependents, CI seeds a fresh DB per run, and subjects are tagged with
 * tag() so rows never collide across runs -- the same "append-only, no
 * cleanup needed" treatment other specs give audit-style rows.
 */

test("support: volunteer submits a General IT request; a manager replies publicly and internally, assigns, awaits, and resolves it; the volunteer sees the public reply and resolution but not the internal note", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const t = tag();
  const subject = `E2E General IT ${t}`;

  // --- Step 1: dev.volunteer submits a General IT request ---
  await devLogin(page, "dev.volunteer@yale.edu");
  await page.goto("/support/new");
  await page.waitForURL((url) => url.pathname === "/support/new");
  await expect(page.getByRole("heading", { name: "Submit a request" })).toBeVisible();

  // Category defaults to General IT -- no selection needed.
  await page.getByLabel("Subject").fill(subject);
  await page.getByLabel("Description").fill("My laptop cannot reach the clinic wifi.");
  await page.getByRole("button", { name: "Submit request" }).click();

  // Server action redirects to /support/<id>?submitted=1.
  await page.waitForURL(
    (url) => /^\/support\/[^/]+$/.test(url.pathname) && url.searchParams.get("submitted") === "1"
  );
  await page.waitForLoadState("networkidle");
  const id = new URL(page.url()).pathname.split("/").pop()!;
  await expect(page.getByRole("heading", { name: subject })).toBeVisible();

  // --- Step 2: the ticket is listed under My requests and opens to the same detail ---
  await page.goto("/support");
  await page.waitForURL((url) => url.pathname === "/support");
  await expect(page.getByRole("heading", { name: "My requests" })).toBeVisible();
  await page.getByRole("link", { name: subject }).click();
  await page.waitForURL((url) => url.pathname === `/support/${id}`);
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { name: subject })).toBeVisible();

  // --- Step 3: a manager finds it under All requests and posts a public reply + an internal note ---
  await page.context().clearCookies();
  await devLogin(page, "j.carney@yale.edu");
  await page.goto("/support/all");
  await page.waitForURL((url) => url.pathname === "/support/all");
  await expect(page.getByRole("heading", { name: "All requests" })).toBeVisible();

  await page.getByPlaceholder("Subject, requester, or ticket #").fill(subject);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.waitForURL((url) => url.searchParams.get("q") === subject);
  await page.waitForLoadState("networkidle");
  await page.getByRole("link", { name: subject }).click();
  await page.waitForURL((url) => url.pathname === `/support/${id}`);
  await page.waitForLoadState("networkidle");

  const conversationSection = page
    .locator("section")
    .filter({ has: page.locator("h2").filter({ hasText: "Conversation" }) })
    .first();

  const publicReply = `Public reply ${t}`;
  await expect(page.getByLabel("Public reply")).toBeChecked();
  await page.getByPlaceholder(/Reply to the requester/).fill(publicReply);
  await page.getByRole("button", { name: "Post" }).click();
  await page.waitForURL((url) => url.pathname === `/support/${id}`);
  await page.waitForLoadState("networkidle");
  await expect(conversationSection.getByText(publicReply)).toBeVisible();

  const internalNote = `Internal note ${t}`;
  await page.getByPlaceholder(/Reply to the requester/).fill(internalNote);
  await page.getByLabel("Internal note").check();
  await page.getByRole("button", { name: "Post" }).click();
  await page.waitForURL((url) => url.pathname === `/support/${id}`);
  await page.waitForLoadState("networkidle");

  const internalSection = page
    .locator("section")
    .filter({ has: page.locator("h2").filter({ hasText: "Internal notes" }) })
    .first();
  await expect(internalSection.getByText(internalNote)).toBeVisible();
  await expect(internalSection.getByText("Internal", { exact: true }).first()).toBeVisible();

  // --- Step 4: assign, move to Awaiting you, resolve ---
  await page.getByLabel("Assignee").selectOption({ label: "Jack Carney" });
  await page.getByRole("button", { name: "Update assignee" }).click();
  await page.waitForURL((url) => url.pathname === `/support/${id}`);
  await page.waitForLoadState("networkidle");

  await page.getByLabel("Status").selectOption({ label: "Awaiting you" });
  await page.getByRole("button", { name: "Update status" }).click();
  await page.waitForURL((url) => url.pathname === `/support/${id}`);
  await page.waitForLoadState("networkidle");
  await expect(page.getByLabel("Status")).toHaveValue("AWAITING_REQUESTER");

  const resolution = `Resolved: reset the wifi profile ${t}`;
  await page.getByLabel("Resolution").fill(resolution);
  await page.getByRole("button", { name: "Resolve ticket" }).click();
  await page.waitForURL((url) => url.pathname === `/support/${id}`);
  await page.waitForLoadState("networkidle");

  const resolutionSection = page
    .locator("section")
    .filter({ has: page.locator("h2").filter({ hasText: "Resolution" }) })
    .first();
  await expect(resolutionSection.getByText(resolution)).toBeVisible();
  await expect(
    page.getByText("This ticket is resolved and can no longer be edited.")
  ).toBeVisible();

  // --- Step 5: the volunteer sees the public reply and the resolution, but not the internal note ---
  await page.context().clearCookies();
  await devLogin(page, "dev.volunteer@yale.edu");
  await page.goto(`/support/${id}`);
  await page.waitForURL((url) => url.pathname === `/support/${id}`);
  await page.waitForLoadState("networkidle");

  await expect(page.getByText(publicReply)).toBeVisible();
  await expect(page.getByText(resolution)).toBeVisible();
  await expect(page.locator("h2").filter({ hasText: "Internal notes" })).toHaveCount(0);
  await expect(page.getByText(internalNote)).not.toBeVisible();
});

test("support epic: volunteer submits an Epic access request; a manager promotes it (choosing the kind) and the linked Epic pipeline appears on the ticket", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const t = tag();
  const subject = `E2E Epic Access ${t}`;

  // dev.volunteer is ACTIVE with no epicId on file and no open Epic request
  // (the seed never sets epicId; no other spec touches it), so when the manager
  // promotes with kind NEW, createEpicRequest's "no epicId on file" precondition
  // holds. Epic operational details are the manager's concern now: the submitter
  // only picks the category and describes the request.
  await devLogin(page, "dev.volunteer@yale.edu");
  await page.goto("/support/new");
  await page.waitForURL((url) => url.pathname === "/support/new");

  await page.getByLabel("Category").selectOption({ label: "Epic access" });
  await page.getByLabel("Subject").fill(subject);
  await page.getByLabel("Description").fill("New Epic account for a new clinic volunteer.");
  await page.getByRole("button", { name: "Submit request" }).click();
  await page.waitForURL(
    (url) => /^\/support\/[^/]+$/.test(url.pathname) && url.searchParams.get("submitted") === "1"
  );
  await page.waitForLoadState("networkidle");
  const id = new URL(page.url()).pathname.split("/").pop()!;
  await expect(page.getByRole("heading", { name: subject })).toBeVisible();

  // A manager finds it under All requests and promotes it.
  await page.context().clearCookies();
  await devLogin(page, "j.carney@yale.edu");
  await page.goto("/support/all");
  await page.waitForURL((url) => url.pathname === "/support/all");

  await page.getByPlaceholder("Subject, requester, or ticket #").fill(subject);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.waitForURL((url) => url.searchParams.get("q") === subject);
  await page.waitForLoadState("networkidle");
  await page.getByRole("link", { name: subject }).click();
  await page.waitForURL((url) => url.pathname === `/support/${id}`);
  await page.waitForLoadState("networkidle");

  // The manager's Epic section: the request-type (kind) selector defaults to NEW
  // for a person with no Epic ID; promote with "Create Epic request".
  await expect(page.getByRole("heading", { name: "Epic access", exact: true })).toBeVisible();
  await expect(page.getByLabel("Request type")).toHaveValue("NEW");
  await page.getByRole("button", { name: "Create Epic request" }).click();
  await page.waitForURL((url) => url.pathname === `/support/${id}`);
  await page.waitForLoadState("networkidle");

  // Promotion succeeded: the "Create Epic request" button is gone and the linked
  // Epic pipeline now renders in its place. (Do not assert on [role="alert"]:
  // the Next.js dev overlay adds one under `next dev`, which CI also uses.)
  await expect(page.getByRole("button", { name: "Create Epic request" })).toHaveCount(0);
  await expect(page.getByText("Epic request status")).toBeVisible();
  await expect(page.getByText("Pending", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Epic ID")).toBeVisible();
  await expect(page.getByRole("button", { name: "Complete" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create YNHH ticket" })).toBeVisible();
});
