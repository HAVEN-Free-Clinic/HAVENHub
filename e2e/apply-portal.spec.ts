import { expect, test } from "@playwright/test";

// The public application portal overrides the hub's browser-tab title with the
// configurable branding.applyPortalTitle setting (default "HAVEN Application
// Portal"), so the portal - and the apply subdomain that serves it - does not
// read "HAVEN Hub". No auth or cycle fixture is needed: the title comes from the
// apply/layout.tsx metadata, which is the same for signed-in and signed-out
// visitors. Regression for the portal inheriting the hub title.
test("apply portal: tab title uses the configurable portal title", async ({ page }) => {
  await page.goto("/apply");
  await expect(page).toHaveTitle(/HAVEN Application Portal/);
});
