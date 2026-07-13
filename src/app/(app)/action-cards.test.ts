import { describe, it, expect } from "vitest";
import { Users } from "lucide-react";
import { buildActionCards, type ActionCard, type ActionCardInput } from "./action-cards";

const base: ActionCardInput = {
  hasScheduleAccess: true,
  hasMyInfoAccess: true,
  upcomingCount: 0,
  nextShiftDaysAway: null,
  pendingSwapCount: 0,
  pendingApprovals: 0,
  compliance: "COMPLIANT",
  trainingIncomplete: 0,
  trainingHref: "/training",
  profileIncomplete: false,
  backfill: [],
};

const shortcut = (key: string, href: string): ActionCard => ({
  key,
  href,
  icon: Users,
  hue: "volunteers",
  label: key,
  sub: "",
  priority: 0,
});

describe("buildActionCards", () => {
  it("ranks approvals above an imminent schedule above swap", () => {
    const cards = buildActionCards({
      ...base,
      pendingApprovals: 2,
      nextShiftDaysAway: 1,
      upcomingCount: 3,
      pendingSwapCount: 1,
    });
    const keys = cards.map((c) => c.key);
    expect(keys[0]).toBe("approvals");
    expect(keys.indexOf("schedule")).toBeLessThan(keys.indexOf("swap"));
  });

  it("omits schedule and swap without schedule access", () => {
    const cards = buildActionCards({ ...base, hasScheduleAccess: false, upcomingCount: 5 });
    expect(cards.find((c) => c.key === "schedule")).toBeUndefined();
    expect(cards.find((c) => c.key === "swap")).toBeUndefined();
  });

  it("shows swap only when there is an upcoming shift", () => {
    expect(buildActionCards({ ...base, upcomingCount: 0 }).find((c) => c.key === "swap")).toBeUndefined();
    expect(buildActionCards({ ...base, upcomingCount: 1 }).find((c) => c.key === "swap")).toBeDefined();
  });

  it("surfaces the most urgent my-info concern, else standing", () => {
    const urgent = buildActionCards({ ...base, compliance: "EXPIRED", profileIncomplete: true })
      .find((c) => c.key === "my-info");
    expect(urgent?.sub).toBe("Upload HIPAA certificate");
    expect(urgent?.priority).toBe(90);

    const standing = buildActionCards(base).find((c) => c.key === "my-info");
    expect(standing?.sub).toBe("View & update");
    expect(standing?.priority).toBe(20);
  });

  it("backfills remaining slots after real actions, never before", () => {
    const cards = buildActionCards({
      ...base,
      backfill: [shortcut("volunteers", "/volunteers"), shortcut("admin", "/admin")],
    });
    const keys = cards.map((c) => c.key);
    expect(keys.slice(0, 2)).toEqual(["schedule", "my-info"]);
    expect(keys).toContain("volunteers");
    expect(keys.indexOf("volunteers")).toBeGreaterThan(keys.indexOf("my-info"));
  });

  it("never returns more than the limit", () => {
    const cards = buildActionCards({
      ...base,
      pendingApprovals: 1,
      trainingIncomplete: 2,
      upcomingCount: 3,
      nextShiftDaysAway: 5,
      backfill: [
        shortcut("volunteers", "/volunteers"),
        shortcut("recruitment", "/recruitment"),
        shortcut("admin", "/admin"),
      ],
    });
    expect(cards.length).toBe(4);
  });
});
