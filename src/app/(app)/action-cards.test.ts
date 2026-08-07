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
  clinicToday: false,
  checkedInToday: false,
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

  it("surfaces EXPIRING_SOON and in-review my-info states", () => {
    const soon = buildActionCards({ ...base, compliance: "EXPIRING_SOON" }).find((c) => c.key === "my-info");
    expect(soon?.priority).toBe(70);
    expect(soon?.sub).toBe("Renew HIPAA soon");

    const review = buildActionCards({ ...base, compliance: "PENDING_VERIFICATION" }).find((c) => c.key === "my-info");
    expect(review?.priority).toBe(40);
    expect(review?.sub).toBe("HIPAA in review");

    const unknown = buildActionCards({ ...base, compliance: "UNKNOWN_DATE" }).find((c) => c.key === "my-info");
    expect(unknown?.sub).toBe("HIPAA in review");
  });

  it("builds the training card with priority 80 and count-aware sub", () => {
    const one = buildActionCards({ ...base, trainingIncomplete: 1, trainingHref: "/training" }).find((c) => c.key === "training");
    expect(one?.priority).toBe(80);
    expect(one?.sub).toBe("To complete");
    expect(one?.href).toBe("/training");

    const many = buildActionCards({ ...base, trainingIncomplete: 2, trainingHref: "/learning" }).find((c) => c.key === "training");
    expect(many?.sub).toBe("2 to complete");
    expect(many?.href).toBe("/learning");
  });

  it("shows the pending swap count when the user has submitted changes", () => {
    const swap = buildActionCards({ ...base, upcomingCount: 2, pendingSwapCount: 1 }).find((c) => c.key === "swap");
    expect(swap?.priority).toBe(40);
    expect(swap?.sub).toBe("1 pending");
  });

  it("surfaces check-in above everything else on a clinic day when not yet checked in", () => {
    const cards = buildActionCards({
      ...base,
      hasScheduleAccess: true,
      clinicToday: true,
      checkedInToday: false,
    });
    expect(cards[0].key).toBe("check-in");
  });

  it("drops the check-in card once the person has checked in", () => {
    const cards = buildActionCards({
      ...base,
      hasScheduleAccess: true,
      clinicToday: true,
      checkedInToday: true,
    });
    expect(cards.find((c) => c.key === "check-in")).toBeUndefined();
  });

  it("shows no check-in card when there is no clinic today", () => {
    const cards = buildActionCards({
      ...base,
      hasScheduleAccess: true,
      clinicToday: false,
      checkedInToday: false,
    });
    expect(cards.find((c) => c.key === "check-in")).toBeUndefined();
  });

  it("omits the check-in card without schedule access, even on a clinic day", () => {
    // Every other false-access case above inherits base's clinicToday: false, so
    // none of them would catch a dropped hasScheduleAccess check inside
    // checkInCard. This one sets clinicToday: true explicitly to close that gap.
    const cards = buildActionCards({
      ...base,
      hasScheduleAccess: false,
      clinicToday: true,
      checkedInToday: false,
    });
    expect(cards.find((c) => c.key === "check-in")).toBeUndefined();
  });
});
