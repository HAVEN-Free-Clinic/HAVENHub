import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { getSetting, setSetting } from "@/platform/settings/service";

beforeEach(async () => {
  await resetDb();
});
afterEach(async () => {
  await resetDb();
});

/**
 * The kill switch for the content blocker gate. It defaults ON because the gate
 * is the feature; it exists as a setting at all so that an Intercom outage,
 * which looks identical to a content blocker from the browser and would gate
 * every member at once, can be answered in seconds from /admin/settings rather
 * than by a rebuild (NEXT_PUBLIC_INTERCOM_APP_ID is inlined at build time).
 */
it("defaults support.blockerGateEnabled to true and honors an override", async () => {
  expect(await getSetting<boolean>("support.blockerGateEnabled")).toBe(true);
  await setSetting("support.blockerGateEnabled", false, null);
  expect(await getSetting<boolean>("support.blockerGateEnabled")).toBe(false);
});
