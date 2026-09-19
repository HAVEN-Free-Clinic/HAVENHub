import { describe, it, expect } from "vitest";
import {
  acceptHeartbeat,
  sectionLength,
  parseTimestamp,
  formatTimestamp,
  MAX_CREDITED_INTERVAL_SECONDS,
} from "./watch";

const t0 = new Date("2026-09-20T12:00:00Z");
const after = (seconds: number) => new Date(t0.getTime() + seconds * 1000);

describe("acceptHeartbeat", () => {
  it("credits honest playback between two heartbeats", () => {
    const r = acceptHeartbeat({
      storedSeconds: 100,
      lastHeartbeatAt: t0,
      reportedSeconds: 110,
      now: after(10),
      length: 1800,
    });
    expect(r.watchedSeconds).toBe(110);
    expect(r.complete).toBe(false);
  });

  it("clamps a jump to what real time allows", () => {
    const r = acceptHeartbeat({
      storedSeconds: 100,
      lastHeartbeatAt: t0,
      reportedSeconds: 1800,
      now: after(10),
      length: 1800,
    });
    // 10 s * 1.1
    expect(r.watchedSeconds).toBeCloseTo(111, 5);
    expect(r.complete).toBe(false);
  });

  it("allows only the fixed slack on the very first heartbeat", () => {
    const r = acceptHeartbeat({
      storedSeconds: 0,
      lastHeartbeatAt: null,
      reportedSeconds: 1800,
      now: t0,
      length: 1800,
    });
    expect(r.watchedSeconds).toBe(5);
  });

  it("never credits more than the capped interval, however long the gap", () => {
    // Open the video, wait an hour, claim the end: the cap is what stops it.
    const r = acceptHeartbeat({
      storedSeconds: 0,
      lastHeartbeatAt: t0,
      reportedSeconds: 1800,
      now: after(3600),
      length: 1800,
    });
    expect(r.watchedSeconds).toBeCloseTo(MAX_CREDITED_INTERVAL_SECONDS * 1.1, 5);
    expect(r.complete).toBe(false);
  });

  it("never moves backwards when the learner rewinds", () => {
    const r = acceptHeartbeat({
      storedSeconds: 500,
      lastHeartbeatAt: t0,
      reportedSeconds: 200,
      now: after(10),
      length: 1800,
    });
    expect(r.watchedSeconds).toBe(500);
  });

  it("marks the section complete within a second of its end", () => {
    const r = acceptHeartbeat({
      storedSeconds: 1790,
      lastHeartbeatAt: t0,
      reportedSeconds: 1799.4,
      now: after(10),
      length: 1800,
    });
    expect(r.watchedSeconds).toBe(1800);
    expect(r.complete).toBe(true);
  });

  it("clamps to the section length", () => {
    const r = acceptHeartbeat({
      storedSeconds: 1795,
      lastHeartbeatAt: t0,
      reportedSeconds: 5000,
      now: after(10),
      length: 1800,
    });
    expect(r.watchedSeconds).toBe(1800);
    expect(r.complete).toBe(true);
  });

  it("ignores a non-finite or negative report", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -50]) {
      const r = acceptHeartbeat({
        storedSeconds: 40,
        lastHeartbeatAt: t0,
        reportedSeconds: bad,
        now: after(10),
        length: 1800,
      });
      expect(r.watchedSeconds).toBe(40);
    }
  });

  it("gives no credit for a heartbeat that claims to come from before the last one", () => {
    const r = acceptHeartbeat({
      storedSeconds: 40,
      lastHeartbeatAt: t0,
      reportedSeconds: 60,
      now: after(-30),
      length: 1800,
    });
    expect(r.watchedSeconds).toBe(40);
  });

  it("a forged run of rapid heartbeats cannot outpace real time", () => {
    let stored = 0;
    let last: Date | null = null;
    // 100 requests one second apart, each claiming the end.
    for (let i = 0; i < 100; i += 1) {
      const now = after(i);
      const r = acceptHeartbeat({ storedSeconds: stored, lastHeartbeatAt: last, reportedSeconds: 1800, now, length: 1800 });
      stored = r.watchedSeconds;
      last = now;
    }
    // 99 s of wall clock. The fixed slack is granted once, on the first
    // heartbeat, so spamming requests buys nothing beyond the 10% rate slack.
    expect(stored).toBeCloseTo(99 * 1.1 + 5, 5);
  });
});

describe("sectionLength", () => {
  it("uses the explicit end when set", () => {
    expect(sectionLength({ startSeconds: 60, endSeconds: 600 }, 3600)).toBe(540);
  });
  it("runs to the end of the video when no end is set", () => {
    expect(sectionLength({ startSeconds: 600, endSeconds: null }, 3600)).toBe(3000);
  });
  it("is null when neither an end nor a duration is known", () => {
    expect(sectionLength({ startSeconds: 0, endSeconds: null }, null)).toBeNull();
  });
  it("clamps an end past the video's duration", () => {
    expect(sectionLength({ startSeconds: 0, endSeconds: 5000 }, 3600)).toBe(3600);
  });
  it("is null for an empty or inverted range", () => {
    expect(sectionLength({ startSeconds: 600, endSeconds: 600 }, 3600)).toBeNull();
    expect(sectionLength({ startSeconds: 700, endSeconds: 600 }, 3600)).toBeNull();
  });
});

describe("parseTimestamp / formatTimestamp", () => {
  it("parses seconds, mm:ss, and h:mm:ss", () => {
    expect(parseTimestamp("45")).toBe(45);
    expect(parseTimestamp("1:05")).toBe(65);
    expect(parseTimestamp("01:02:03")).toBe(3723);
    expect(parseTimestamp(" 2:00 ")).toBe(120);
  });
  it("returns null for blank input", () => {
    expect(parseTimestamp("")).toBeNull();
    expect(parseTimestamp("   ")).toBeNull();
  });
  it("rejects malformed input", () => {
    expect(parseTimestamp("abc")).toBeUndefined();
    expect(parseTimestamp("1:75")).toBeUndefined();
    expect(parseTimestamp("1:2:3:4")).toBeUndefined();
    expect(parseTimestamp("-5")).toBeUndefined();
  });
  it("formats round trips", () => {
    expect(formatTimestamp(65)).toBe("1:05");
    expect(formatTimestamp(3723)).toBe("1:02:03");
    expect(formatTimestamp(0)).toBe("0:00");
    expect(formatTimestamp(59.9)).toBe("0:59");
  });
});
