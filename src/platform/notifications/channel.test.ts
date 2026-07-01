import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveChannel } from "./channel";
import * as settings from "@/platform/settings/service";

describe("resolveChannel", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("reads the per-type channel setting by its dotted key", async () => {
    const spy = vi.spyOn(settings, "getSetting").mockResolvedValue("both" as never);
    const channel = await resolveChannel("epic-onboarding");
    expect(channel).toBe("both");
    expect(spy).toHaveBeenCalledWith("notifications.epic-onboarding.channel");
  });
});
