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

  it("never puts clinic check-in in this feed", () => {
    // Check-in used to be a card here, but in the tile grid it rendered
    // identically to the navigation shortcuts, so the one time-sensitive action
    // on a clinic morning read as another shortcut. It now has its own banner
    // above the feed. This guards against it being reintroduced as a tile, which
    // would put the same action on screen twice.
    const cards = buildActionCards({ ...base, hasScheduleAccess: true });
    expect(cards.find((c) => c.key === "check-in")).toBeUndefined();
  });

  /**
   * Faculty with a Hub account are not on the volunteer clearance track, but
   * `compliance` is computed off the live term regardless of membership and
   * reads NO_CERTIFICATE for them. Unsuppressed that took priority 90 and led
   * their feed with a requirement they hold no shift under.
   */
  describe("suppressComplianceNudge", () => {
    it("leads with the HIPAA upload when NOT suppressed", () => {
      const cards = buildActionCards({ ...base, compliance: "NO_CERTIFICATE" });
      const myInfo = cards.find((c) => c.key === "my-info")!;
      expect(myInfo.sub).toBe("Upload HIPAA certificate");
      expect(cards[0].key).toBe("my-info");
    });

    it("drops every compliance nudge when suppressed, keeping the card", () => {
      for (const compliance of ["NO_CERTIFICATE", "EXPIRED", "EXPIRING_SOON", "PENDING_VERIFICATION", "UNKNOWN_DATE"] as const) {
        const cards = buildActionCards({ ...base, compliance, suppressComplianceNudge: true });
        const myInfo = cards.find((c) => c.key === "my-info")!;
        expect(myInfo.sub).toBe("View & update");
        expect(myInfo.priority).toBe(20);
      }
    });

    /** Confirming your own contact details is asked of anyone with an account. */
    it("still surfaces an incomplete profile when suppressed", () => {
      const cards = buildActionCards({
        ...base,
        compliance: "NO_CERTIFICATE",
        profileIncomplete: true,
        suppressComplianceNudge: true,
      });
      expect(cards.find((c) => c.key === "my-info")!.sub).toBe("1 to confirm");
    });
  });
});
