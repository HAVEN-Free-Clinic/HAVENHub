import { describe, expect, it } from "vitest";
import { describeActivity } from "./activity-log";

describe("describeActivity", () => {
  it("names the fields a save changed", () => {
    expect(describeActivity("campaign.update", { fields: ["subject", "body", "audience"] })).toBe(
      "edited the subject, message, and audience",
    );
  });

  it("joins two fields with and", () => {
    expect(describeActivity("campaign.update", { fields: ["subject", "body"] })).toBe("edited the subject and message");
  });

  it("phrases every action the service records", () => {
    const actions: Array<[string, unknown]> = [
      ["campaign.list_edit", { op: "paste" }],
      ["campaign.test_send", null],
      ["campaign.send", { recipientCount: 1 }],
      ["campaign.schedule", { scheduleType: "RECURRING" }],
      ["campaign.unschedule", null],
      ["campaign.cancel", null],
      ["campaign.duplicate", null],
      ["campaign.retry_failed", { count: 3 }],
      ["campaign.dispatch_empty", null],
    ];
    for (const [action, after] of actions) {
      expect(describeActivity(action, after)).not.toBe(action);
    }
    expect(describeActivity("campaign.send", { recipientCount: 1 })).toBe("sent it to 1 recipient");
  });
});
