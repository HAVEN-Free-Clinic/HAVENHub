import { describe, it, expect } from "vitest";
import { NOTIFICATION_TYPES, channelSettingKey } from "./registry";
import { getSettingDef } from "@/platform/settings/registry";

describe("notification registry", () => {
  it("declares the existing notification types", () => {
    const keys = NOTIFICATION_TYPES.map((t) => t.key).sort();
    expect(keys).toEqual(
      [
        "compliance-date-review",
        "compliance-escalation",
        "compliance-reminder",
        "epic-activation",
        "epic-onboarding",
        "epic-password-reset",
        "recruitment.interview_assignment",
      ].sort()
    );
    for (const t of NOTIFICATION_TYPES) {
      expect(t.defaultChannel).toBe("email");
    }
  });

  it("builds the dotted channel setting key", () => {
    expect(channelSettingKey("compliance-reminder")).toBe(
      "notifications.compliance-reminder.channel"
    );
  });

  it("registers a channel select setting per type in the settings registry", () => {
    for (const t of NOTIFICATION_TYPES) {
      const def = getSettingDef(channelSettingKey(t.key));
      expect(def.category).toBe("Notifications");
      expect(def.input).toEqual({
        type: "select",
        options: [
          { value: "email", label: "Email" },
          { value: "teams", label: "Teams DM" },
          { value: "both", label: "Email + Teams DM" },
        ],
      });
      expect(def.envDefault()).toBe("email");
    }
  });
});
