import { expect, test } from "@playwright/test";
import { loginAs } from "./auth";
import { prisma } from "./fixtures";

/**
 * Journey: admin creates an email campaign draft, authors a subject with a
 * template variable, adds an audience condition, and asserts the client-side
 * live preview renders the sample value "Sam".
 *
 * We use the TemplateEditor's live preview (pure client-side, no send required)
 * rather than the "Send test to me" action, which would queue a real email via
 * queueEmail() and requires a connected mailbox to verify delivery. The live
 * preview is deterministic and CI-safe: it renders sample variables
 * (firstName="Sam", name="Sam Rivera") in-browser without touching the network.
 *
 * The audience-preview action ("Preview audience") returns a recipient count but
 * does not show "Sam"; the live preview does. We therefore assert the preview
 * column, not a post-action banner.
 */
test("admin email: create a campaign with an audience condition and preview", async ({
  page,
}) => {
  const campaignName = `E2E Campaign ${Date.now()}`;
  let campaignId: string | null = null;

  try {
    await loginAs(page, "admin");

    // --- Step 1: Open the new-campaign form and submit ---
    await page.goto("/admin/email/campaigns/new");
    await page.fill('input[name="name"]', campaignName);
    await page.getByRole("button", { name: "Create" }).click();

    // Server action creates the draft and redirects to /admin/email/campaigns/[id].
    await page.waitForURL(/\/admin\/email\/campaigns\/[a-z0-9]+$/);
    campaignId = page.url().split("/").pop() ?? null;

    // --- Step 2: Author the subject with a template variable ---
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

    // --- Step 4: Add one audience condition via the builder ---
    await page.getByRole("button", { name: /Add condition/i }).click();

    // The "No conditions yet" notice is replaced by a condition row.
    await expect(page.getByText(/No conditions yet/)).not.toBeVisible();

    // The default condition row contains a field-selector <select> showing "Full name"
    // (the first PERSON_FIELD_VIEWS entry, key="name", label="Full name").
    // An empty "contains" condition matches nobody, preserving the safety invariant.
    await expect(
      page.locator("select").filter({ hasText: "Full name" }),
    ).toBeVisible();
  } finally {
    // Cleanup: delete the draft campaign (EmailCampaignRun rows cascade-delete).
    // A draft has no runs, but the catch guard keeps cleanup idempotent.
    if (campaignId) {
      await prisma.emailCampaign
        .delete({ where: { id: campaignId } })
        .catch(() => {});
    }
  }
});
