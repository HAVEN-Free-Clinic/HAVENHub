import { expect, test } from "@playwright/test";

test.setTimeout(120_000);

async function devLogin(page: import("@playwright/test").Page, email: string) {
  await page.goto("/login");
  await page.fill('input[name="email"]', email);
  await page.click('button:has-text("Dev sign in")');
  await page.waitForURL((url) => url.pathname === "/");
}

// Regression for the TestSprite TC021 finding ("Offboard button does nothing").
// The Offboard control is a two-click <ConfirmButton>: the first click ARMS it
// (relabelling to the confirm prompt) and the second click submits the form.
// The generated TestSprite script kept clicking a button named exactly
// "Offboard", which no longer exists once armed, so it never confirmed and the
// action never fired. Driving the real two-step interaction proves the feature
// works. A throwaway person is created so no imported roster data is mutated.
test("offboard: the two-click confirm button ends an active person's status", async ({
  page,
}) => {
  await devLogin(page, "j.carney@yale.edu");

  const stamp = Date.now();
  await page.goto("/admin/people/new");
  await page.fill('input[name="name"]', `E2E Offboard ${stamp}`);
  await page.fill('input[name="contactEmail"]', `e2e.offboard.${stamp}@yale.edu`);
  await page.click('button:has-text("Save")');
  // createAction redirects to /admin/people/<id>?saved=1
  await page.waitForURL((url) => /\/admin\/people\/[^/]+$/.test(url.pathname));

  // A new person defaults to ACTIVE, so the Status section shows the idle Offboard button.
  const idle = page.getByRole("button", { name: "Offboard", exact: true });
  await expect(idle).toBeVisible();

  // First click ARMS the button: it relabels to the confirm prompt and does NOT submit.
  await idle.click();
  const confirm = page.getByRole("button", { name: /^Offboard\? This ends/ });
  await expect(confirm).toBeVisible();
  // While armed, no button named exactly "Offboard" exists — this is precisely
  // what the generated TestSprite script kept (fruitlessly) clicking.
  await expect(page.getByRole("button", { name: "Offboard", exact: true })).toHaveCount(0);

  // Second click submits the surrounding form -> offboardAction -> status OFFBOARDED.
  await confirm.click();

  // The Status section flips to the Reactivate control, proving the action ran.
  await expect(page.getByRole("button", { name: "Reactivate", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Offboard/ })).toHaveCount(0);
});
