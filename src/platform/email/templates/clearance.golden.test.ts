/**
 * Golden tests for the clearance email templates (onboarding reminder and the
 * weekly director digest), rendered through renderEmail so the branded layout is
 * exercised the same way the compliance templates are.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { renderEmail } from "./renderEmail";
import { onboardingReminderContext } from "./clearance";

beforeEach(resetDb);

const APP_URL = "https://hub.example.org";
const BRAND = "#00356b";

describe("onboarding-reminder", () => {
  it("lists every outstanding item as its own row", async () => {
    const out = await renderEmail(
      "onboarding-reminder",
      onboardingReminderContext({
        personName: "Jane Doe",
        items: [
          "Confirm your contact details in your profile",
          "Complete your assigned learning courses",
        ],
        appUrl: APP_URL,
        brandColor: BRAND,
      }),
    );
    expect(out.subject).toBe("[HAVEN] Outstanding onboarding requirements");
    expect(out.html).toContain("<li>Confirm your contact details in your profile</li>");
    expect(out.html).toContain("<li>Complete your assigned learning courses</li>");
    expect(out.html).toContain(`${APP_URL}/get-started`);
  });

  it("escapes item text, which can carry admin-entered EHS course names", async () => {
    const out = await renderEmail(
      "onboarding-reminder",
      onboardingReminderContext({
        personName: "Jane Doe",
        items: ['Complete your required EHS training: <script>alert("x")</script>'],
        appUrl: APP_URL,
        brandColor: BRAND,
      }),
    );
    expect(out.html).not.toContain("<script>");
    expect(out.html).toContain("&lt;script&gt;");
  });

  it("uses the singular noun for a single outstanding item", async () => {
    const out = await renderEmail(
      "onboarding-reminder",
      onboardingReminderContext({
        personName: "Jane Doe",
        items: ["Finish this term's volunteer training"],
        appUrl: APP_URL,
        brandColor: BRAND,
      }),
    );
    expect(out.html).toContain("1 item");
    expect(out.html).not.toContain("1 items");
  });
});
