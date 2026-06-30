import { expect, test } from "@playwright/test";
import { loginAs } from "./auth";
import { seedComplianceMember } from "./fixtures";

test("infra: admin login + fixture create/cleanup round trip", async ({ page }) => {
  await loginAs(page, "admin");
  await expect(page).toHaveURL((url) => url.pathname === "/");

  const member = await seedComplianceMember("ITCM");
  expect(member.person.id).toBeTruthy();
  await member.cleanup();
});
