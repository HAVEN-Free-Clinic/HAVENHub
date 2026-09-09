import { describe, it, expect } from "vitest";
import { NOTIFICATION_TYPES, channelSettingKey } from "./registry";
import { getSettingDef } from "@/platform/settings/registry";

describe("notification registry", () => {
  it("declares the existing notification types", () => {
    const keys = NOTIFICATION_TYPES.map((t) => t.key).sort();
    expect(keys).toEqual(
      [
        "compliance-date-review",
        "compliance-verification-review",
        "compliance-cert-verified",
        "compliance-reminder",
        "onboarding-reminder",
        "clearance-digest",
        "attendance-nudge",
        "epic-activation",
        "epic-onboarding",
        "epic-password-reset",
        "incidents.info_provided",
        "incidents.info_requested",
        "incidents.report_resolved",
        "incidents.report_submitted",
        "incidents.strike_decided",
        "incidents.strike_issued",
        "incidents.strike_issued_directors",
        "incidents.strike_requested",
        "recruitment.applicant_withdrew",
        "recruitment.interview_assignment",
        "recruitment.review_digest",
        "support.ticket_submitted",
        "support.ticket_manager_alert",
        "support.status_changed",
        "support.comment_added",
        "support.request_resolved",
        "shift-reminder",
        "shift-reminder-cc",
        "shift-reminder-triage",
        "clinic-checkin-invite",
        "volunteers.language_assessed",
        "volunteers.dual_role_requested",
        "volunteers.language_claimed",
        "volunteers.self_withdrawal",
      ].sort()
    );
    // Email is the default for every type EXCEPT the ones deliberately quieted,
    // named here one by one. An allowlist rather than a loosened assertion,
    // because the failure this guards against is a type going quiet by accident:
    // a notification nobody receives and nobody notices is indistinguishable
    // from one that was never sent.
    const QUIET: Record<string, "inbox"> = { "volunteers.language_assessed": "inbox" };
    for (const t of NOTIFICATION_TYPES) {
      expect(t.defaultChannel).toBe(QUIET[t.key] ?? "email");
    }
  });

  it("builds the dotted channel setting key", () => {
    expect(channelSettingKey("compliance-reminder")).toBe(
      "notifications.compliance-reminder.channel"
    );
  });

  it("registers a channel select setting per type in the settings registry", () => {
    const OPTIONS = [
      { value: "email", label: "Email" },
      { value: "teams", label: "Teams DM" },
      { value: "both", label: "Email + Teams DM" },
      { value: "inbox", label: "In-app only (no email or DM)" },
    ];
    for (const t of NOTIFICATION_TYPES) {
      const def = getSettingDef(channelSettingKey(t.key));
      expect(def.category).toBe("Notifications");
      expect(def.input).toEqual({ type: "select", options: OPTIONS });
      // The registry's own default, whatever it is, must be one the picker can
      // actually offer. A type defaulting to a value absent from the options
      // renders as a select with nothing selected, and saving the form silently
      // moves it to the first option.
      expect(def.envDefault()).toBe(t.defaultChannel);
      expect(OPTIONS.map((o) => o.value)).toContain(t.defaultChannel);
    }
  });
});
