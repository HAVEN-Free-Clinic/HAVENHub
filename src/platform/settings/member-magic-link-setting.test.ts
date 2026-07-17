import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { getSetting, setSetting } from "@/platform/settings/service";

beforeEach(async () => {
  await resetDb();
});
afterEach(async () => {
  await resetDb();
});

it("defaults auth.memberMagicLinkEnabled to true and honors an override", async () => {
  expect(await getSetting<boolean>("auth.memberMagicLinkEnabled")).toBe(true);
  await setSetting("auth.memberMagicLinkEnabled", false, null);
  expect(await getSetting<boolean>("auth.memberMagicLinkEnabled")).toBe(false);
});
