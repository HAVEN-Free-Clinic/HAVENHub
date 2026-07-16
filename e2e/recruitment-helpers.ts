import { expect, type Page } from "@playwright/test";

/**
 * Pick departments in the new-cycle form's searchable multi-select (MultiCombobox).
 *
 * Types each code into the search box and commits the highlighted match with
 * Enter (clicking the option is avoided: the option detaches from the list the
 * instant it is selected, which can make a stray click land on a neighbour).
 * Each code must exist as an active Department (seeded via the department
 * catalog) or it will not appear as an option.
 */
export async function selectDepartments(page: Page, codes: string[]): Promise<void> {
  const search = page.locator('input[role="combobox"][aria-label="Departments"]');
  for (const code of codes) {
    await search.click();
    await search.fill(code);
    // The matching option must be filtered in before we commit it with Enter.
    await expect(page.locator(`[role="option"][data-value="${code}"]`)).toBeVisible();
    await search.press("Enter");
    // Committed: the value is now carried by a hidden input (as a removable chip).
    await expect(page.locator(`input[type="hidden"][name="departments"][value="${code}"]`)).toBeAttached();
  }
}
