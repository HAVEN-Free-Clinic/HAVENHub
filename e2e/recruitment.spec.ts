import { expect, test } from "@playwright/test";
import { applicantSessionCookie } from "./portal-cookie";

test.setTimeout(120_000);

async function devLogin(page: import("@playwright/test").Page, email: string) {
  await page.goto("/login");
  await page.fill('input[name="email"]', email);
  await page.click('button:has-text("Dev sign in")');
  await page.waitForURL((url) => url.pathname === "/");
}

// Modernized end-to-end of the recruitment pipeline. The previous version of this
// spec broke on two app changes that were never reflected here:
//   1. The form builder was rewritten from an inline "Add field" <form> to a
//      <TypePicker> dropdown (role="menu" / role="menuitem").
//   2. The public /apply/[slug] page now requires a verified applicant identity
//      (magic-link). A fresh anonymous context is redirected to /apply, so the
//      test forges the signed applicant_session cookie instead (see portal-cookie).
//
// Renewal + conditional department-supplement validation remain covered at the
// integration level by submissions.test.ts; this e2e proves the UI wiring of
// build -> publish -> public apply -> review.
test("recruitment: build (TypePicker), publish, public apply via portal, view submission", async ({
  page,
  context,
}) => {
  await devLogin(page, "j.carney@yale.edu");

  const slug = `e2e-vol-${Date.now()}`;

  // --- Create the cycle (DRAFT) -> redirected into the builder ---
  await page.goto("/recruitment/cycles/new");
  await page.fill('input[name="title"]', "E2E Volunteer Cycle");
  await page.fill('input[name="publicSlug"]', slug);
  await page.fill('input[name="departments"]', "SRHD, MDIC");
  await page.click('button:has-text("Create")');
  await page.waitForURL((url) => url.pathname.includes("/builder"));
  const cycleId = page.url().split("/cycles/")[1].split("/")[0];

  // --- Add a field through the rewritten builder (TypePicker dropdown) ---
  const identitySection = page
    .locator("section")
    .filter({ has: page.locator("h2").filter({ hasText: "Your information" }) })
    .first();
  await identitySection.getByRole("button", { name: /Add field/ }).click();
  await page.getByRole("menuitem", { name: "Paragraph" }).click();
  // The new field renders with its default label; it is optional so it does not
  // affect the submission below.
  await expect(identitySection.getByText("Paragraph", { exact: true })).toBeVisible();

  // --- Publish ---
  await page.goto(`/recruitment/cycles/${cycleId}`);
  await page.click('button:has-text("Publish")');
  await expect(page.locator("span").filter({ hasText: "OPEN" })).toBeVisible();

  // --- Public NEW application as a verified portal applicant ---
  const applicantEmail = `e2e-applicant-${Date.now()}@yale.edu`;
  const pub = await context.browser()!.newContext();
  await pub.addCookies([applicantSessionCookie(applicantEmail)]);
  const apply = await pub.newPage();
  await apply.goto(`/apply/${slug}`);

  await apply.fill('input[name="first_name"]', "Ann");
  await apply.fill('input[name="last_name"]', "New");
  await apply.fill('input[name="email"]', applicantEmail);
  await apply.click('button:has-text("Submit application")');
  await expect(apply.getByText(/your application was received/i)).toBeVisible();
  await pub.close();

  // --- Verify the submission shows in the applicants list ---
  // The server binds the application to the verified identity email, so that is
  // the address that appears in the roster.
  await page.goto(`/recruitment/cycles/${cycleId}/applicants`);
  await expect(page.getByText(applicantEmail)).toBeVisible();
});
