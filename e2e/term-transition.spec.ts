import { expect, test } from "@playwright/test";
import { devLogin } from "./auth";
import { seedComplianceMember, seedPlanningTerm } from "./fixtures";

let member: Awaited<ReturnType<typeof seedComplianceMember>>;
let planning: Awaited<ReturnType<typeof seedPlanningTerm>>;

test.beforeEach(async () => {
  // An ITCM member on the ACTIVE term with no next-term place and no
  // application, so they land in the Not returning bucket.
  member = await seedComplianceMember("ITCM", { status: "COMPLIANT" });
  planning = await seedPlanningTerm("SP99");
});

test.afterEach(async () => {
  await planning.cleanup();
  await member.cleanup();
});

/**
 * Flags via the Transition tab's bulk action, verifies the person reaches the
 * Flagged queue, then unflags to restore state.
 *
 * The Not returning bucket starts with every eligible row pre-checked: once
 * the fixture's brand-new PLANNING term exists, EVERY member of the active
 * roster lacks a next-term place, so they all land in Not returning and are
 * all selected by default. Submitting that default selection would flag the
 * whole roster, and this test only unflags the one person it seeded, leaking
 * OffboardFlag rows for everyone else. Narrow the selection to just the
 * seeded member first: clear the bucket's select-all, then check only their
 * row, and assert the button label proves exactly one person is selected
 * before ever clicking it.
 *
 * Deliberately does not execute the offboard: that would set the person
 * OFFBOARDED and break afterEach cleanup. bulkExecuteOffboard is covered by
 * the integration tests in transition-actions.test.ts.
 */
test("term transition: bulk flag from the Transition tab reaches the flagged queue", async ({
  page,
}) => {
  await devLogin(page, "j.carney@yale.edu");
  await page.goto("/volunteers/offboarding?tab=transition");
  await page.waitForURL((url) => url.searchParams.get("tab") === "transition");

  // The header names both terms, so the report resolved a next term.
  await expect(page.getByRole("heading", { name: /SP99/ })).toBeVisible();

  const personName = member.person.name;
  const row = page.locator("tbody tr").filter({ hasText: personName }).first();
  await expect(row).toBeVisible();

  // Not returning is pre-checked for everyone, including this row.
  await expect(row.getByRole("checkbox")).toBeChecked();

  // Clear the bucket's default (every-row) selection, then select only the
  // seeded member's own row.
  await page.getByRole("checkbox", { name: "Select all Not returning", exact: true }).click();
  await expect(row.getByRole("checkbox")).not.toBeChecked();
  await row.getByRole("checkbox", { name: `Select ${personName}`, exact: true }).click();
  await expect(row.getByRole("checkbox")).toBeChecked();

  // Proves the selection is exactly the one person before mutating anything.
  const flagButton = page.getByRole("button", { name: "Flag 1 for offboarding", exact: true });
  await expect(flagButton).toBeVisible();
  await flagButton.click();

  // Anchored to the result alert's actual text, not the loose "flagged" copy
  // that also appears in the "Flagged" tab label and badge.
  const flagAlert = page.getByRole("status").filter({ hasText: /^1 flagged$/ });
  await expect(flagAlert).toBeVisible();

  await page.getByRole("link", { name: "Flagged", exact: true }).click();
  await page.waitForURL((url) => url.searchParams.get("tab") === "flagged");

  const flaggedRow = page.locator("tbody tr").filter({ hasText: personName }).first();
  await expect(flaggedRow).toBeVisible();

  // Restore state: unflag through the two-click ConfirmButton protocol.
  await flaggedRow.getByRole("button", { name: "Unflag", exact: true }).click();
  await flaggedRow.getByRole("button").filter({ hasText: /\?/ }).first().click();
  await expect(page.locator("tbody tr").filter({ hasText: personName })).toHaveCount(0);
});

test("term transition: the export downloads a CSV", async ({ page }) => {
  await devLogin(page, "j.carney@yale.edu");
  await page.goto("/volunteers/offboarding?tab=transition");
  await page.waitForURL((url) => url.searchParams.get("tab") === "transition");

  // Proves the default selection has rendered before the export click reads it.
  await expect(page.getByRole("button", { name: /^Offboard \d+$/ })).toBeEnabled();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export emails CSV" }).click();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toMatch(/^haven-offboarding-.*\.csv$/);
});
