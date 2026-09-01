import { expect, test } from "@playwright/test";

const COPYRIGHT = /© Copyright \d{4} HAVEN Free Clinic IT Department/;

test("the attributions page credits every contributor and is reachable signed out", async ({
  page,
}) => {
  await page.goto("/attributions");
  await expect(page.getByRole("heading", { name: "Attributions", level: 1 })).toBeVisible();

  for (const [name, email] of [
    ["Jack Carney", "j.carney@yale.edu"],
    ["Caprice Culkin", "caprice.culkin@yale.edu"],
    ["Renée Tracey", "renee.tracey@yale.edu"],
    ["Antigone Antonakakis", "antigone.antonakakis@yale.edu"],
  ]) {
    await expect(page.getByText(name, { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: email })).toHaveAttribute(
      "href",
      `mailto:${email}`
    );
  }

  await expect(page.getByText("Executive Director, 2025-2026", { exact: true })).toBeVisible();

  await expect(page.getByText(COPYRIGHT)).toBeVisible();
});

test("the sign-in screen carries the notice and links to the credits", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByText(COPYRIGHT)).toBeVisible();
  await page.getByRole("link", { name: "Attributions" }).click();
  await page.waitForURL((url) => url.pathname === "/attributions");
  await expect(page.getByRole("heading", { name: "Attributions", level: 1 })).toBeVisible();
});

test("the 404 page carries the notice", async ({ page }) => {
  await page.goto("/this-page-does-not-exist");
  await expect(page.getByText(COPYRIGHT)).toBeVisible();
  await expect(page.getByRole("link", { name: "Attributions" })).toBeVisible();
});

test("the public application portal carries the notice", async ({ page }) => {
  await page.goto("/apply");
  await expect(page.getByText(COPYRIGHT)).toBeVisible();
  await expect(page.getByRole("link", { name: "Attributions" })).toBeVisible();
});

test("the signed-in app footer carries the notice alongside the org line", async ({ page }) => {
  await page.goto("/login");
  await page.fill('input[name="email"]', "j.carney@yale.edu");
  await page.click('button:has-text("Dev sign in")');
  await page.waitForURL((url) => url.pathname === "/");

  const footer = page.getByRole("contentinfo");
  await expect(footer.getByText("HAVEN Free Clinic · Yale University")).toBeVisible();
  await expect(footer.getByText(COPYRIGHT)).toBeVisible();
  await expect(footer.getByRole("link", { name: "Attributions" })).toBeVisible();
});
