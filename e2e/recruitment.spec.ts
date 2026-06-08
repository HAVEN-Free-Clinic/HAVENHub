import { expect, test } from "@playwright/test";

test.setTimeout(120_000);

async function devLogin(page: import("@playwright/test").Page, email: string) {
  await page.goto("/login");
  await page.fill('input[name="email"]', email);
  await page.click('button:has-text("Dev sign in")');
  await page.waitForURL((url) => url.pathname === "/");
}

test("recruitment: build, publish, public apply (new + renewal), view submissions", async ({
  page,
  context,
}) => {
  await devLogin(page, "j.carney@yale.edu");

  // Use a timestamp slug to avoid conflicts across test runs.
  const slug = `e2e-vol-${Date.now()}`;

  // --- Create cycle ---
  await page.goto("/recruitment/cycles/new");
  await page.fill('input[name="title"]', "E2E Volunteer Cycle");
  await page.fill('input[name="publicSlug"]', slug);
  await page.fill('input[name="departments"]', "SRHD, MDIC");
  await page.click('button:has-text("Create")');
  // Server action redirects to /recruitment/cycles/<id>/builder
  await page.waitForURL((url) => url.pathname.includes("/builder"));
  const cycleId = page.url().split("/cycles/")[1].split("/")[0];

  // --- Add DEPARTMENT_CHOICE to the "Your information" section ---
  // The identity section is a <section> element with an h2 containing "Your information"
  const identitySection = page
    .locator("section")
    .filter({ has: page.locator("h2").filter({ hasText: "Your information" }) })
    .first();

  const identityAddForm = identitySection.locator(
    'form:has(select[name="type"])'
  );
  await identityAddForm.locator('input[name="label"]').fill("1st choice department");
  await identityAddForm.locator('select[name="type"]').selectOption("DEPARTMENT_CHOICE");
  await identityAddForm.locator('button:has-text("Add field")').click();
  // Server action calls revalidatePath; wait for the new field to appear in the section
  await expect(
    identitySection.locator("li").filter({ hasText: "1st choice department" })
  ).toBeVisible();

  // --- Add SRHD supplement section ---
  const addSectionForm = page.locator("form").filter({
    has: page.locator('input[name="title"][placeholder="New section title"]'),
  });
  await addSectionForm.locator('input[name="title"]').fill("SRHD Supplement");
  await addSectionForm.locator('select[name="appliesTo"]').selectOption("NEW");
  await addSectionForm.locator('input[name="departmentCode"]').fill("SRHD");
  await addSectionForm.locator('button:has-text("Add section")').click();
  // Wait for the new section to appear
  await expect(
    page.locator("h2").filter({ hasText: "SRHD Supplement" })
  ).toBeVisible();

  // Add a required field to the SRHD supplement section
  const srhdSection = page
    .locator("section")
    .filter({ has: page.locator("h2").filter({ hasText: "SRHD Supplement" }) })
    .first();
  const srhdAddForm = srhdSection.locator('form:has(select[name="type"])');
  await srhdAddForm.locator('input[name="label"]').fill("SRHD essay");
  await srhdAddForm.locator('select[name="type"]').selectOption("LONG_TEXT");
  await srhdAddForm.locator('input[name="required"]').check();
  await srhdAddForm.locator('button:has-text("Add field")').click();
  await expect(srhdSection.locator("li").filter({ hasText: "SRHD essay" })).toBeVisible();

  // --- Enable renewals from the overview page ---
  await page.goto(`/recruitment/cycles/${cycleId}`);
  await expect(page.locator("span").filter({ hasText: "DRAFT" })).toBeVisible();
  await page.click('button:has-text("Enable renewal branch")');
  // revalidatePath keeps us on the same URL; button text flips to "Disable renewal branch"
  await expect(
    page.locator('button:has-text("Disable renewal branch")')
  ).toBeVisible();

  // --- Add RENEWAL section in builder ---
  await page.goto(`/recruitment/cycles/${cycleId}/builder`);
  const addSectionForm2 = page.locator("form").filter({
    has: page.locator('input[name="title"][placeholder="New section title"]'),
  });
  await addSectionForm2.locator('input[name="title"]').fill("Renewal Questions");
  await addSectionForm2.locator('select[name="appliesTo"]').selectOption("RENEWAL");
  await addSectionForm2.locator('button:has-text("Add section")').click();
  await expect(
    page.locator("h2").filter({ hasText: "Renewal Questions" })
  ).toBeVisible();

  // Add a required field to the Renewal section
  const renewalSection = page
    .locator("section")
    .filter({ has: page.locator("h2").filter({ hasText: "Renewal Questions" }) })
    .first();
  const renewAddForm = renewalSection.locator('form:has(select[name="type"])');
  await renewAddForm.locator('input[name="label"]').fill("Continue reason");
  await renewAddForm.locator('input[name="required"]').check();
  await renewAddForm.locator('button:has-text("Add field")').click();
  await expect(renewalSection.locator("li").filter({ hasText: "Continue reason" })).toBeVisible();

  // --- Publish the cycle ---
  await page.goto(`/recruitment/cycles/${cycleId}`);
  await page.click('button:has-text("Publish")');
  // publishCycleAction calls revalidatePath (no redirect); wait for OPEN status badge
  await expect(page.locator("span").filter({ hasText: "OPEN" })).toBeVisible();

  // --- Public NEW application in a fresh unauthenticated context ---
  const pub = await context.browser()!.newContext();
  const apply = await pub.newPage();
  await apply.goto(`/apply/${slug}`);

  // The form renders with "New applicant" as the default applicantType.
  // Fill identity fields (key = first_name, last_name, email — seeded by createCycle)
  await apply.fill('input[name="first_name"]', "Ann");
  await apply.fill('input[name="last_name"]', "New");
  await apply.fill('input[name="email"]', "ann.new@yale.edu");

  // DEPARTMENT_CHOICE field: key = "1st_choice_department" (slugified from label)
  // Selecting SRHD triggers React state update, making SRHD Supplement section visible.
  await apply.locator('select[name="1st_choice_department"]').selectOption("SRHD");
  // Wait for the SRHD supplement fieldset to appear (React re-render)
  await expect(apply.locator("legend").filter({ hasText: "SRHD Supplement" })).toBeVisible();

  // SRHD essay is LONG_TEXT => <textarea name="srhd_essay">
  await apply.locator('textarea[name="srhd_essay"]').fill("I want to help.");

  await apply.click('button:has-text("Submit application")');
  await expect(apply.getByText(/your application was received/i)).toBeVisible();

  // --- Public RENEWAL application ---
  await apply.goto(`/apply/${slug}`);
  // The "Renewing in my current department" radio is the second radio in the fieldset
  await apply.getByText("Renewing in my current department").click();
  // Wait for the renewal dept select to appear (rendered conditionally after radio change)
  const renewalDeptSelect = apply
    .locator("div")
    .filter({ hasText: /Current department/ })
    .locator("select");
  await expect(renewalDeptSelect).toBeVisible();

  // Select MDIC as the current (renewal) department
  await renewalDeptSelect.selectOption("MDIC");

  // Fill identity fields
  await apply.fill('input[name="first_name"]', "Cy");
  await apply.fill('input[name="last_name"]', "Renew");
  await apply.fill('input[name="email"]', "cy.renew@yale.edu");

  // The Renewal Questions section should now be visible for renewal applicants
  await expect(apply.locator("legend").filter({ hasText: "Renewal Questions" })).toBeVisible();
  // "Continue reason" is SHORT_TEXT (default) => <input type="text" name="continue_reason">
  await apply.fill('input[name="continue_reason"]', "Loved it.");

  await apply.click('button:has-text("Submit application")');
  await expect(apply.getByText(/your application was received/i)).toBeVisible();
  await pub.close();

  // --- Verify both submissions in the applicants list ---
  await page.goto(`/recruitment/cycles/${cycleId}/applicants`);
  await expect(page.getByText("ann.new@yale.edu")).toBeVisible();
  await expect(page.getByText("cy.renew@yale.edu")).toBeVisible();
  // The RENEWAL row shows "RENEWAL" in the Type column (applicantType field)
  await expect(page.getByText("RENEWAL")).toBeVisible();
});
