import { expect, test } from "@playwright/test";
import { applicantSessionCookie } from "./portal-cookie";
import { selectDepartments } from "./recruitment-helpers";

// This is the heaviest spec (build a form via TypePicker, publish, then apply via
// the portal). On a cold CI dev server those routes compile on first hit, so allow
// extra headroom on top of the per-spec default.
test.setTimeout(180_000);

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
  await selectDepartments(page, ["SRHD", "MDIC"]);
  // Build the form ourselves (minimal name+email seed) so the apply wizard stays
  // a simple identity-only flow; the default form has required files + subcommittees.
  await page.uncheck('input[name="seedDefaultForm"]');
  await page.click('button:has-text("Create")');
  await page.waitForURL((url) => url.pathname.includes("/builder"));
  const cycleId = page.url().split("/cycles/")[1].split("/")[0];

  // --- Add a field through the rewritten builder (TypePicker dropdown) ---
  const identitySection = page
    .locator("section")
    .filter({ has: page.locator("h2").filter({ hasText: "Your information" }) })
    .first();
  await identitySection.getByRole("button", { name: /Add field/ }).click();
  await page.getByRole("button", { name: "Paragraph", exact: true }).click();
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

  // Walk the wizard. Only the current step is shown, so fill the identity fields
  // when their section is the visible step, advance with Continue, and submit on
  // the final Review step (Submit application shows only there).
  const submit = apply.getByRole("button", { name: "Submit application" });
  const continueBtn = apply.getByRole("button", { name: "Continue" });
  const firstName = apply.locator('input[name="first_name"]');
  for (let i = 0; i < 8; i++) {
    // Settle on the current step before acting: non-review steps show Continue,
    // the Review step shows Submit (mutually exclusive). Without this, an immediate
    // isVisible() could miss the just-mounted Submit and then blind-click a Continue
    // already gone on Review, hanging the whole test. Bounded so a stuck page fails
    // fast for the retry instead of consuming the full timeout.
    await expect(continueBtn.or(submit)).toBeVisible({ timeout: 45_000 });
    if (await submit.isVisible().catch(() => false)) break;
    if (await firstName.isVisible().catch(() => false)) {
      await firstName.fill("Ann");
      await apply.fill('input[name="last_name"]', "New");
      await apply.fill('input[name="email"]', applicantEmail);
    }
    await continueBtn.click();
  }
  await expect(submit).toBeVisible();
  await submit.click();

  await expect(apply.getByText(/your application was received/i)).toBeVisible();
  await pub.close();

  // --- Verify the submission shows in the applicants list ---
  // The server binds the application to the verified identity email, so that is
  // the address that appears in the roster.
  await page.goto(`/recruitment/cycles/${cycleId}/applicants`);
  await expect(page.getByText(applicantEmail)).toBeVisible();
});

// A slug that matches no cycle must not masquerade as a real-but-closed form.
// An anonymous visitor is bounced to the portal sign-in (redirect to /apply) so
// they can sign in and see what is actually open, rather than landing on a bare
// "Applications are closed" notice for an arbitrary URL. Regression for the apply
// subdomain not prompting sign-in on random slugs.
test("recruitment: unknown apply slug redirects an anonymous visitor to portal sign-in", async ({ context }) => {
  const anon = await context.browser()!.newContext();
  const page = await anon.newPage();
  await page.goto(`/apply/does-not-exist-${Date.now()}`);
  await expect(page).toHaveURL((url) => url.pathname === "/apply");
  await expect(page.getByRole("link", { name: /Sign in with Yale/i })).toBeVisible();
  await expect(page.getByText(/Applications are closed/i)).toHaveCount(0);
  await anon.close();
});
