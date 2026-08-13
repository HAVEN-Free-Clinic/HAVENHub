import { expect, test } from "@playwright/test";
import { devLogin } from "./auth";
import { tag } from "./fixtures";

/**
 * IT Support module: submit, track, comment (public/internal), manager
 * actions, and attaching Epic access requests to a ticket.
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
 * cleanup needed" treatment other specs give audit-style rows. The Epic test
 * does cancel the Epic request it attaches (via the UI, not a DB cleanup
 * helper) so the shared dev.volunteer persona is left with no open Epic
 * request and no epicId, matching what every other spec assumes about it.
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

  // Server action redirects to /support/<id>?submitted=1, but the toast reader strips
  // that param, so waiting on it being present is a race. Exclude "new" explicitly: this
  // click starts on /support/new, which a bare /support/<segment> pattern already
  // matches, so the wait would return immediately and `id` below could capture the
  // literal string "new".
  await page.waitForURL((url) => /^\/support\/(?!new$)[^/]+$/.test(url.pathname));
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

  await page.getByLabel("Status").selectOption({ label: "Awaiting requester" });
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

test("support epic: volunteer submits an Epic access request; a manager attaches an Epic request via the new attach flow, then cancels it", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const t = tag();
  const subject = `E2E Epic Access ${t}`;

  // dev.volunteer is a shared persona used across the suite: the seed never
  // sets its epicId and no other spec leaves it with an open Epic request, so
  // this test must not complete the attached request, set an Epic ID, or
  // create a YNHH ticket (those mutate shared state and are already covered
  // by unit tests). It cancels the request it attaches at the end, leaving
  // only a CANCELLED row behind -- no open request, epicId still unset.
  await devLogin(page, "dev.volunteer@yale.edu");
  await page.goto("/support/new");
  await page.waitForURL((url) => url.pathname === "/support/new");

  await page.getByLabel("Category").selectOption({ label: "Epic access" });
  await page.getByLabel("Subject").fill(subject);
  await page.getByLabel("Description").fill("New Epic account for a new clinic volunteer.");
  await page.getByRole("button", { name: "Submit request" }).click();
  // As above: exclude "new", which this click starts on, or the wait is a no-op and `id`
  // can capture the literal string "new".
  await page.waitForURL((url) => /^\/support\/(?!new$)[^/]+$/.test(url.pathname));
  await page.waitForLoadState("networkidle");
  const id = new URL(page.url()).pathname.split("/").pop()!;
  await expect(page.getByRole("heading", { name: subject })).toBeVisible();

  // A manager finds it under All requests and attaches an Epic request via the
  // ticket's "Epic access" section (the attach flow: Tasks 1-8 replaced the old
  // single inline promote-and-pipeline with a many-requests-per-ticket attach
  // form; the old pipeline now lives on its own page at /support/epic).
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

  // The old inline promote-and-pipeline UI is gone from the ticket page.
  await expect(page.getByRole("button", { name: "Create Epic request" })).toHaveCount(0);
  await expect(page.getByText("Epic request status")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create YNHH ticket" })).toHaveCount(0);

  // The new "Epic access" section: attach form defaults "Request type" to NEW
  // (EPIC_KIND_LABELS.NEW = "New account"), quick-add the requester via the
  // picker's "+ Add requester (...)" button, then attach.
  const epicSection = page
    .locator("section")
    .filter({ has: page.locator("h2").filter({ hasText: "Epic access" }) })
    .first();
  // Scope attached-row assertions to the list (a <ul>): the kind label text
  // ("New account") also appears as an <option> in the attach form's "Request
  // type" Select, so an unscoped getByText would match both (strict-mode error).
  const attachedList = epicSection.locator("ul");
  await expect(page.getByRole("heading", { name: "Epic access", exact: true })).toBeVisible();
  await expect(page.getByLabel("Request type")).toHaveValue("NEW");
  await page.getByRole("button", { name: /Add requester/ }).click();
  await page.getByRole("button", { name: "Attach Epic request(s)" }).click();
  await page.waitForURL((url) => url.pathname === `/support/${id}`);
  await page.waitForLoadState("networkidle");

  // Attaching succeeded: a new row renders with the kind and status badges.
  // (Do not assert on [role="alert"]: the Next.js dev overlay adds one under
  // `next dev`, which CI also uses.)
  await expect(attachedList.getByText("New account")).toBeVisible();
  await expect(attachedList.getByText("Pending", { exact: true })).toBeVisible();

  // Cancel the attached request so the shared dev.volunteer persona is left
  // clean: a CANCELLED Epic request, no open request, epicId never set.
  await attachedList.getByRole("button", { name: "Cancel" }).click();
  await page.waitForURL((url) => url.pathname === `/support/${id}`);
  await page.waitForLoadState("networkidle");
  await expect(attachedList.getByText("Pending", { exact: true })).toHaveCount(0);
  await expect(attachedList.getByRole("button", { name: "Cancel" })).toHaveCount(0);
});

test("support: a view-only auditor sees every request and a ticket's status, but no conversation, no manager controls, and no Epic tools", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const t = tag();
  const subject = `E2E Auditor View ${t}`;

  // A volunteer files a ticket, so the auditor has a real conversation section
  // that must stay hidden from them.
  await devLogin(page, "dev.volunteer@yale.edu");
  await page.goto("/support/new");
  await page.waitForURL((url) => url.pathname === "/support/new");
  await page.getByLabel("Subject").fill(subject);
  await page.getByLabel("Description").fill("Auditor visibility check.");
  await page.getByRole("button", { name: "Submit request" }).click();
  await page.waitForURL((url) => /^\/support\/(?!new$)[^/]+$/.test(url.pathname));
  await page.waitForLoadState("networkidle");
  const id = new URL(page.url()).pathname.split("/").pop()!;

  // --- The auditor: /support/all is reachable and lists everyone's tickets ---
  await page.context().clearCookies();
  await devLogin(page, "dev.support-auditor@yale.edu");
  await page.goto("/support/all");
  // Not /no-access: requireAnyPermission admits support.view_all_requests. This
  // assertion is the reason the test exists -- a permission-gated href that
  // bounces is invisible to every other test layer.
  await page.waitForURL((url) => url.pathname === "/support/all");
  await expect(page.getByRole("heading", { name: "All requests" })).toBeVisible();

  // The Epic / YNHH tab is the module's one destructive surface (it submits real
  // access requests) and must never be offered to a read-only viewer.
  await expect(page.getByRole("link", { name: "Epic / YNHH tools" })).toHaveCount(0);

  await page.getByPlaceholder("Subject, requester, or ticket #").fill(subject);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.waitForURL((url) => url.searchParams.get("q") === subject);
  await page.waitForLoadState("networkidle");
  await page.getByRole("link", { name: subject }).click();
  await page.waitForURL((url) => url.pathname === `/support/${id}`);
  await page.waitForLoadState("networkidle");

  // The ticket renders at all. The regression this guards is a 500: listComments
  // throws SupportNotFoundError for a viewer who is neither requester nor
  // manager, so the page must not call it for an auditor.
  await expect(page.getByRole("heading", { name: subject })).toBeVisible();

  // ...but none of the correspondence, and none of the manager controls.
  await expect(page.getByRole("heading", { name: "Conversation" })).toHaveCount(0);
  await expect(page.getByPlaceholder(/Reply to the requester/)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Attachments" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Epic access", exact: true })).toHaveCount(0);
});
