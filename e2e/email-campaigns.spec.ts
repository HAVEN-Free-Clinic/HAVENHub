import { expect, test, type Locator, type Page } from "@playwright/test";
import { loginAs } from "./auth";
import { prisma, tag } from "./fixtures";

/**
 * The campaign editor is a TABBED shell (Compose / Audience / Review & send),
 * and every panel stays mounted on every tab, toggled with the `hidden`
 * attribute rather than conditional rendering (see page.tsx). Two consequences
 * govern every selector in this file:
 *
 * 1. A control on a tab that is not showing is in the DOM but out of the
 *    accessibility tree, so `getByRole(...)` resolves to nothing and any click
 *    on it hangs until the test times out. Switch tabs first, always.
 * 2. For the same reason `expect(x).not.toBeVisible()` is worthless here: it
 *    passes both when a notice is gone AND when it is still there on a hidden
 *    tab. Assert absence with `toHaveCount(0)`.
 *
 * Both of these were live: before this file was repaired, the spec below
 * clicked "Add condition" while the Compose tab was showing and failed on the
 * 30s test timeout on every run.
 */

/**
 * The editor's own tab link, scoped to the editor's tab row.
 *
 * NOT `page.getByRole("link", { name: "Audience" })` and emphatically not
 * `a:has-text("Audience")`: the Outreach module nav on this same page carries
 * an "Audience scopes" link, which both of those match, and clicking it
 * navigates out of the editor entirely.
 */
function editorTab(page: Page, name: "Compose" | "Audience" | "Review & send"): Locator {
  return page
    .getByRole("navigation", { name: "Campaign editor sections" })
    .getByRole("link", { name, exact: true });
}

/** Creates a draft from the new-campaign form and returns its id. */
async function createDraft(page: Page, name: string): Promise<string> {
  await page.goto("/outreach/campaigns/new");
  await page.fill('input[name="name"]', name);
  // Audience scope defaults to "No scope (everyone)" for an unrestricted sender.
  await page.getByRole("button", { name: "Create" }).click();
  // The server action creates the draft and redirects to the editor. Capture the
  // id BEFORE any tab switch, which appends `?tab=` to the URL.
  await page.waitForURL(/\/outreach\/campaigns\/[a-z0-9]+$/);
  return page.url().split("/").pop() ?? "";
}

async function deleteDraft(id: string | null): Promise<void> {
  // EmailCampaignRun rows cascade-delete. A draft has no runs, but the catch
  // guard keeps cleanup idempotent.
  if (id) await prisma.emailCampaign.delete({ where: { id } }).catch(() => {});
}

/**
 * Journey: admin creates an email campaign draft, authors a subject with a
 * template variable, asserts the client-side live preview renders the sample
 * value "Sam", then crosses to the Audience tab and builds a condition and a
 * nested group.
 *
 * We use the TemplateEditor's live preview (pure client-side, no send required)
 * rather than the "Send test to me" action, which would queue a real email via
 * queueEmail() and requires a connected mailbox to verify delivery. The live
 * preview is deterministic and CI-safe: it renders sample variables
 * (firstName="Sam", name="Sam Rivera") in-browser without touching the network.
 */
test("admin email: create a campaign with an audience condition and preview", async ({
  page,
}) => {
  const campaignName = `E2E Campaign ${Date.now()}`;
  let campaignId: string | null = null;

  try {
    await loginAs(page, "admin");

    // --- Step 1: Open the new-campaign form and submit ---
    campaignId = await createDraft(page, campaignName);

    // --- Step 2: Author the subject with a template variable ---
    // The editor opens on Compose, so the subject input is on the showing tab.
    // The TemplateEditor client component immediately re-renders the preview
    // column whenever the subject input changes, substituting sample values.
    // firstName sample value is "Sam" (from PERSON_VARIABLES in variables.ts).
    await page.fill('input[name="subject"]', "Hello {{ firstName }}");

    // --- Step 3: Assert the live preview shows the rendered sample value ---
    // The preview column renders:
    //   <span>Subject:&nbsp;</span>
    //   <strong>{previewSubject}</strong>   <- "Hello Sam" once hydrated
    // No server call or email send is needed; this is a purely client-side render.
    await expect(
      page.locator("strong").filter({ hasText: "Hello Sam" }),
    ).toBeVisible();

    // --- Step 4: Cross to the Audience tab ---
    // Required, not cosmetic: the builder below is `hidden` on Compose.
    await editorTab(page, "Audience").click();
    await page.waitForURL(/\?tab=audience$/);

    // --- Step 4b: the unsaved subject SURVIVED the crossing ---
    // The premise the whole tabbed editor rests on, and nothing else asserts
    // it. Every tab is a real navigation to ?tab=..., and everything unsaved on
    // this page is client state: the subject and body live in TemplateEditor's
    // useState and the entire audience tree lives in AudienceBuilder's. If a
    // tab switch remounted the page tree the way a server action's redirect
    // does, crossing to Audience to build the audience would silently discard
    // the subject typed in step 2, and the recipient panel's dirty guard would
    // come up clean and let the next click destroy the rest. Asserted on the
    // input's live value rather than the preview, so it is the form state being
    // measured and not a re-render of saved data.
    await editorTab(page, "Compose").click();
    await page.waitForURL(/\?tab=compose$/);
    await expect(page.locator('input[name="subject"]')).toHaveValue("Hello {{ firstName }}");
    await editorTab(page, "Audience").click();
    await page.waitForURL(/\?tab=audience$/);

    // --- Step 5: Add one audience condition via the builder ---
    await page.getByRole("button", { name: /Add condition/i }).click();

    // The "No conditions yet" notice is replaced by a condition row. Asserted as
    // absence from the DOM, not as invisibility: see the note at the top.
    await expect(page.getByText(/No conditions yet/)).toHaveCount(0);

    // The default condition row's field control is the searchable FieldPicker
    // (a button opening a grouped listbox), NOT the flat <select> it replaced.
    // Its accessible name carries the chosen field and that field's group, so
    // this pins both the default field (PERSON_FIELD_VIEWS[0], key="name",
    // label="Full name") and the group it now lives in.
    await expect(
      page.getByRole("button", { name: "Field: Full name, Identity" }),
    ).toBeVisible();

    // An empty "contains" condition matches nobody, preserving the safety
    // invariant. The operator select is kind-aware, so this also pins that a
    // text field opens on the text operator rather than a shared default.
    await expect(page.getByRole("combobox", { name: "Operator" })).toHaveValue(
      "contains",
    );

    // --- Step 6: Add a nested group (Airtable-style) and confirm it renders ---
    // The root group's "+ Add group" button appends an empty nested group, which
    // shows its own empty-state notice until a condition is added to it.
    await page.getByRole("button", { name: /Add group/i }).first().click();
    await expect(page.getByText(/Empty group/)).toBeVisible();

    // --- Step 7: a REJECTED save keeps everything unsaved on the page ---
    // The blocker this spec exists to keep closed. Every navigation off this
    // route replaces the page tree below AppShell through the (app)/loading.tsx
    // Suspense boundary, and everything unsaved here is client state: the name,
    // the subject and body in TemplateEditor, and the whole audience tree in
    // AudienceBuilder. So saveAction returns its problems instead of
    // redirecting with them. A mistyped template variable is the ordinary way
    // in, and it used to cost the sender the lot.
    await editorTab(page, "Compose").click();
    await page.waitForURL(/\?tab=compose$/);
    await page.fill('input[name="name"]', `${campaignName} renamed`);
    await page.fill('input[name="subject"]', "Hello {{ firstNam }}");
    await page.getByRole("button", { name: "Save" }).click();

    // The problem renders in place. Nothing navigated: the URL is untouched.
    await expect(page.getByText(/Unknown variable in subject: firstNam/)).toBeVisible();
    await expect(page).toHaveURL(/\?tab=compose$/);

    // And all three kinds of unsaved state are still there. The name is
    // asserted because it is the one React would reset on its own: an
    // uncontrolled field is restored to its defaultValue after a form action,
    // so this field is deliberately controlled (campaign-name-field.tsx).
    await expect(page.locator('input[name="name"]')).toHaveValue(`${campaignName} renamed`);
    await expect(page.locator('input[name="subject"]')).toHaveValue("Hello {{ firstNam }}");
    await editorTab(page, "Audience").click();
    await page.waitForURL(/\?tab=audience$/);
    await expect(page.getByText(/Empty group/)).toBeVisible();
  } finally {
    await deleteDraft(campaignId);
  }
});

/**
 * Journey: admin builds a DATE condition on the Audience tab, watches the live
 * per-node count settle on a real number, saves, and reads the saved recipient
 * roll back off the page.
 *
 * What this covers that the unit tests cannot. value-controls.test.tsx,
 * use-node-counts.test.tsx and recipient-preview.test.tsx each render one
 * component against stubbed props and a stubbed action; service.test.ts
 * resolves audiences against the database with no browser involved. Nobody
 * checks that the three meet:
 *
 *   - that the date control is reachable at all, i.e. that the tab holding it
 *     is the one showing (exactly the failure that had this file red);
 *   - that picking a date field through the FieldPicker actually re-defaults
 *     the condition to a date operator and swaps the generic text input for the
 *     date control, rather than leaving a text box wired to a date compiler;
 *   - that the count the browser renders comes from a real server action bound
 *     to this campaign and its scope, not from a mock;
 *   - that the audience the builder serialises into its hidden input survives
 *     Save and resolves, through the real compiler, to the same people the
 *     per-node count promised.
 *
 * The empty-date assertion in the middle is the safety invariant in its
 * user-visible form: an incomplete condition matches NOBODY and says so, rather
 * than silently matching everybody.
 */
test("admin email: a date condition counts matches and the saved roll lists recipients", async ({
  page,
}) => {
  const campaignName = `E2E Audience ${Date.now()}`;
  let campaignId: string | null = null;

  try {
    await loginAs(page, "admin");
    campaignId = await createDraft(page, campaignName);

    await editorTab(page, "Audience").click();
    await page.waitForURL(/\?tab=audience$/);

    // Before anything is saved the roll is empty, and the panel says which kind
    // of empty it is. Pinned so the assertion at the end cannot pass on a stale
    // render of a roll that was already populated.
    await expect(page.getByText(/This audience matches nobody/)).toBeVisible();

    await page.getByRole("button", { name: /Add condition/i }).click();

    // --- Swap the default text field for a date field via the field picker ---
    await page.getByRole("button", { name: "Field: Full name, Identity" }).click();
    await page.getByRole("combobox", { name: "Search fields" }).fill("Joined");
    // The option's accessible name is the label ALONE; the group is announced
    // once by the enclosing role="group", not folded into every option.
    await page
      .getByRole("option", { name: "Joined the roster", exact: true })
      .click();

    await expect(
      page.getByRole("button", { name: "Field: Joined the roster, Identity" }),
    ).toBeVisible();

    // A date field re-defaults its operator to one the field actually declares.
    // "eq" is not in DATE_OPERATORS, and a condition carrying it would compile
    // to match-nobody, which widens rather than narrows inside a NONE group.
    await expect(page.getByRole("combobox", { name: "Operator" })).toHaveValue(
      "onOrAfter",
    );

    // --- The date control, and the match-nobody note it carries while empty ---
    const dateInput = page.getByLabel("Date", { exact: true });
    await expect(dateInput).toHaveAttribute("type", "date");
    await expect(page.getByText(/No date chosen yet/)).toBeVisible();

    // Every seeded person joined the roster when the seed ran, so a boundary in
    // the past matches all of them. Deliberately not "today": a boundary that
    // moves with the clock is how a date spec starts failing at midnight.
    await dateInput.fill("2020-01-01");
    await expect(page.getByText(/No date chosen yet/)).toHaveCount(0);

    // --- The live per-node count ---
    // Path "0" is the first child of the root group (see node-paths.ts). The
    // number is not hard-coded: this asserts the count resolved to at least one
    // person, which is what distinguishes a working condition from one that
    // compiled to the match-nobody sentinel. Generous timeout: a 400ms debounce
    // plus a server action the dev server may still be compiling.
    await expect(page.locator('[data-node-count="0"]')).toHaveText(
      /^Matches [1-9]\d* (person|people)$/,
      { timeout: 20_000 },
    );
    // ...and the root group counts the whole tree, not just the leaf.
    await expect(page.locator('[data-node-count="root"]')).toHaveText(
      /^Matches [1-9]\d* (person|people)$/,
    );

    // --- Save, and read the roll back ---
    // Save is in the sticky footer, deliberately outside the tab panels, so it
    // is reachable from the Audience tab without switching back to Compose.
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForURL(/\?tab=audience&saved=1$/);

    // The roll is server-rendered from the SAVED audience, so reaching it at all
    // proves the builder's hidden input round-tripped through saveAction and
    // resolved through the real compiler.
    await expect(page.getByRole("heading", { name: "Recipients" })).toBeVisible();
    await expect(page.getByText(/This audience matches nobody/)).toHaveCount(0);
    await expect(
      page.getByText(/^[1-9]\d* recipients?$/),
    ).toBeVisible();

    // At least one named person, with an address, is actually listed.
    const rows = page.getByRole("table").locator("tbody tr");
    await expect(rows.first()).toBeVisible();
    await expect(rows.first().locator("td").nth(1)).toContainText("@");
  } finally {
    await deleteDraft(campaignId);
  }
});

/**
 * Seeds one recruitment cycle and seven applicants, sized so that every
 * recruitment-outcome cohort is a DIFFERENT number of people.
 *
 * A cycle is seeded rather than assumed: the three cycle-keyed outcome fields
 * draw their checkboxes from the LIVE cycle list (loadAudienceBuilderOptions),
 * and the base seed ships no RecruitmentCycle at all, so without this the
 * builder would render "No options available" and nothing could be ticked.
 *
 * The differing sizes are the load-bearing part, and they are what a first
 * draft of this fixture got wrong. Counts stay on screen while the next request
 * is in flight (they are flagged stale, not blanked -- see useNodeCounts), so a
 * `toHaveText` that polls its way to a match will happily match the PREVIOUS
 * field's number and pass without the new field ever having been counted.
 * One-per-cohort made every expected number 1, which is precisely the shape
 * that cannot tell those two apart. With 1 / 2 / 3 / 4 no stale value is ever
 * equal to the value being waited for, so the assertion can only pass on a
 * genuinely recounted tree.
 *
 * The seventh applicant carries a BARE interview row -- created, never invited,
 * exactly what createInterview writes -- so the invited cohort is 2 rather than
 * 3 only if the field really keys on `invitedAt`.
 */
async function seedOutcomeCycle() {
  const admin = await prisma.person.findFirstOrThrow({
    where: { contactEmail: "j.carney@yale.edu" },
  });
  const stamp = tag();
  const term = await prisma.term.create({
    data: {
      code: `OC${stamp}`,
      name: `E2E Outcomes ${stamp}`,
      startDate: new Date("2099-01-01"),
      endDate: new Date("2099-05-01"),
      status: "PLANNING",
    },
  });
  const cycle = await prisma.recruitmentCycle.create({
    data: {
      track: "VOLUNTEER",
      termId: term.id,
      createdById: admin.id,
      title: `E2E Outcomes ${stamp}`,
      publicSlug: `e2e-outcomes-${stamp}`,
    },
  });

  const personIds: string[] = [];
  async function applicant(
    label: string,
    applicantType: "NEW" | "RENEWAL",
    extra: { decision?: "REJECT"; status?: "WITHDRAWN"; interview?: "bare" | "invited" },
  ) {
    const email = `e2e-${label}-${stamp}@example.com`.toLowerCase();
    const p = await prisma.person.create({
      data: { name: `E2E ${label} ${stamp}`, contactEmail: email, status: "ACTIVE" },
    });
    personIds.push(p.id);
    const a = await prisma.applicant.create({
      data: {
        cycleId: cycle.id,
        applicantPersonId: p.id,
        firstName: "E2E",
        lastName: label,
        email,
        emailLower: email,
      },
    });
    const app = await prisma.application.create({
      data: {
        cycleId: cycle.id,
        applicantId: a.id,
        answers: {},
        applicantType,
        ...(extra.decision ? { decision: extra.decision, decidedAt: new Date() } : {}),
        ...(extra.status ? { status: extra.status, withdrawnAt: new Date() } : {}),
      },
    });
    if (extra.interview) {
      const invited = extra.interview === "invited";
      await prisma.interview.create({
        data: {
          applicationId: app.id,
          departmentCode: "CARDIO",
          createdById: admin.id,
          scheduledAt: invited ? new Date("2099-02-01T15:00:00.000Z") : null,
          invitedAt: invited ? new Date("2099-01-20T15:00:00.000Z") : null,
        },
      });
    }
  }

  // 1 rejected, 2 invited, 3 withdrew; 3 renewals and 4 new.
  await applicant("rejected", "RENEWAL", { decision: "REJECT" });
  await applicant("invited-a", "RENEWAL", { interview: "invited" });
  await applicant("invited-b", "RENEWAL", { interview: "invited" });
  await applicant("withdrew-a", "NEW", { status: "WITHDRAWN" });
  await applicant("withdrew-b", "NEW", { status: "WITHDRAWN" });
  await applicant("withdrew-c", "NEW", { status: "WITHDRAWN" });
  await applicant("bare-interview", "NEW", { interview: "bare" });

  return {
    cycleTitle: cycle.title,
    cleanup: async () => {
      // Applicant cascades to Application, which cascades to Interview.
      await prisma.applicant.deleteMany({ where: { cycleId: cycle.id } });
      await prisma.recruitmentCycle.delete({ where: { id: cycle.id } }).catch(() => {});
      await prisma.person.deleteMany({ where: { id: { in: personIds } } });
      await prisma.term.delete({ where: { id: term.id } }).catch(() => {});
    },
  };
}

/**
 * Journey: admin picks each of the four recruitment-outcome fields through the
 * real FieldPicker, fills its value control, and watches the live per-node
 * count come back with the number the seeded cohort predicts.
 *
 * What this covers that nothing else does. person-fields.test.ts compiles these
 * conditions against a stubbed ctx; recruitment-fields.test.ts resolves them
 * against the database with no browser; audience-builder.test.tsx renders the
 * builder against stubbed props and a stubbed count action. None of them sees
 * the three meet, and this branch has shipped several defects that were
 * compile-clean and lint-clean and failed only when a page was actually
 * rendered. So this asserts the whole chain, per field:
 *
 *   - the field is REACHABLE in the picker at all (a new field whose group or
 *     label is wrong is invisible while every unit test still passes);
 *   - its value control is the right one AND is populated -- the three
 *     cycle-keyed fields have to find the live cycle list rather than render
 *     "No options available", and applicantType has to render its enum select;
 *   - the count element EXISTS and carries a number. That is the load-bearing
 *     half: countNodesAction degrades a server-side throw to an empty map and
 *     NodeCount renders nothing at all for a missing count, so a compiler that
 *     blew up on a new field leaves no element rather than an error message;
 *   - the number is the seeded cohort's, so a field wired to the wrong bucket
 *     surfaces as the wrong count rather than as a passing test.
 *
 * Two structural choices keep it from passing vacuously. Every assertion goes
 * through a SETTLED locator (`data-stale="false"`), because the previous
 * field's count stays on screen while the next request is in flight. And a
 * second clause pinning the audience to the seeded cycle rides along in every
 * tree, so the root count is bounded by this fixture rather than by whatever
 * applicants another spec left in the shared database -- which matters for
 * applicantType, the one field that names no cycle and so spans all of them.
 */
test("admin email: every recruitment outcome field picks, fills and counts", async ({
  page,
}) => {
  const campaignName = `E2E Outcomes ${Date.now()}`;
  let campaignId: string | null = null;
  const seeded = await seedOutcomeCycle();

  // Only a SETTLED count is ever asserted on. `stale` is true from the render
  // that changes the tree until the answer for that change lands (see
  // useNodeCounts), and a stale row still shows the old number, so a locator
  // without this attribute would let `toHaveText` match the previous field's
  // count and report a pass for a field that was never counted.
  const leaf = page.locator('[data-node-count="0"][data-stale="false"]');
  const root = page.locator('[data-node-count="root"][data-stale="false"]');

  /**
   * Repoints the FIRST condition row at `label` through the real picker.
   *
   * `.first()` throughout: the tree carries two rows and row 0 is the one under
   * test. Row 1 is pinned to "Applied to recruitment cycle" for the whole test,
   * so first/last stay stable rather than depending on what row 0 currently is.
   */
  async function pickField(current: string, label: string) {
    await page.getByRole("button", { name: `Field: ${current}` }).click();
    await page.getByRole("combobox", { name: "Search fields" }).fill(label);
    // The option's accessible name is the label ALONE; the group is announced
    // once by the enclosing role="group", not folded into every option.
    await page.getByRole("option", { name: label, exact: true }).click();
    await expect(
      page.getByRole("button", { name: `Field: ${label}, Recruitment` }),
    ).toBeVisible();
  }

  try {
    await loginAs(page, "admin");
    campaignId = await createDraft(page, campaignName);
    await editorTab(page, "Audience").click();
    await page.waitForURL(/\?tab=audience$/);

    // --- Row 0: the field under test, starting on the first outcome field ---
    await page.getByRole("button", { name: /Add condition/i }).click();
    await pickField("Full name, Identity", "Rejected in cycle");

    // --- Row 1: the cycle pin, set once and left alone ---
    await page.getByRole("button", { name: /Add condition/i }).click();
    await pickField("Full name, Identity", "Applied to recruitment cycle");
    await page.getByRole("checkbox", { name: seeded.cycleTitle }).last().check();

    // --- The three cycle-keyed fields, each ticked against the seeded cycle ---
    const cycleFields: [string, string, number][] = [
      ["Rejected in cycle", "Rejected in cycle", 1],
      ["Rejected in cycle, Recruitment", "Invited to interview in cycle", 2],
      ["Invited to interview in cycle, Recruitment", "Withdrew from cycle", 3],
    ];
    for (const [from, label, expected] of cycleFields) {
      // The first entry is already selected from the setup above; repointing it
      // to itself would reopen the picker on a field it is already showing.
      if (from !== label) await pickField(from, label);
      // A multiEnum field re-defaults to a set operator its own registry
      // declares. "in" over an empty selection is the safe starting state.
      await expect(page.getByRole("combobox", { name: "Operator" }).first()).toHaveValue("in");
      // The live cycle list reached the checkbox group, rather than the
      // "No options available" a field with no option source renders.
      await expect(page.getByText("No options available")).toHaveCount(0);
      await page.getByRole("checkbox", { name: seeded.cycleTitle }).first().check();
      // Generous timeout: a 400ms debounce plus a server action the dev server
      // may still be compiling.
      const people = expected === 1 ? "person" : "people";
      await expect(leaf).toHaveText(`Matches ${expected} ${people}`, { timeout: 20_000 });
      await expect(root).toHaveText(`Matches ${expected} ${people}`, { timeout: 20_000 });
    }

    // --- applicantType: an enum select, not a checkbox group ---
    await pickField("Withdrew from cycle, Recruitment", "Applicant type");
    await expect(page.getByRole("combobox", { name: "Operator" }).first()).toHaveValue("eq");
    const valueSelect = page.getByRole("combobox", { name: "Value" });
    // Defaults to the registry's first option rather than to a blank, so the
    // condition is complete the moment the field is chosen.
    await expect(valueSelect).toHaveValue("NEW");
    // The leaf spans every cycle, so only its SHAPE is pinned here; the root,
    // which is intersected with the cycle pin, carries the exact number.
    await expect(leaf).toHaveText(/^Matches \d+ (person|people)$/, { timeout: 20_000 });
    await expect(root).toHaveText("Matches 4 people", { timeout: 20_000 });
    // Changing the value re-counts, and 3 is a number no earlier step left on
    // screen, so this cannot pass on a stale render either.
    await valueSelect.selectOption("RENEWAL");
    await expect(root).toHaveText("Matches 3 people", { timeout: 20_000 });
  } finally {
    await deleteDraft(campaignId);
    await seeded.cleanup();
  }
});
