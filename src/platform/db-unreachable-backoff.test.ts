import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/platform/logging", () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  errorAttrs: vi.fn(() => ({})),
}));

import { log } from "@/platform/logging";
import { createUnreachableBackoff } from "./db-unreachable-backoff";

describe("createUnreachableBackoff", () => {
  beforeEach(() => {
    vi.mocked(log.warn).mockClear();
    vi.mocked(log.info).mockClear();
  });

  it("polls at the base interval while healthy and logs nothing", () => {
    const b = createUnreachableBackoff({ scope: "[t]", baseMs: 2000, maxMs: 10000 });
    b.succeeded();
    b.succeeded();
    expect(b.nextDelayMs()).toBe(2000);
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });

  it("logs once on entering an outage, however many ticks fail", () => {
    const b = createUnreachableBackoff({ scope: "[t]", baseMs: 2000, maxMs: 10000 });
    for (let i = 0; i < 100; i++) b.failed(new Error("P1001"));
    expect(log.warn).toHaveBeenCalledOnce();
    expect(vi.mocked(log.warn).mock.calls[0]![0]).toContain("[t] database unreachable");
  });

  it("backs off exponentially, capped so recovery is still prompt", () => {
    const b = createUnreachableBackoff({ scope: "[t]", baseMs: 2000, maxMs: 10000 });
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      b.failed(new Error("down"));
      delays.push(b.nextDelayMs());
    }
    expect(delays).toEqual([4000, 8000, 10000, 10000, 10000, 10000]);
  });

  it("logs recovery once with the outage length, then returns to the base interval", () => {
    let t = 1_000;
    const b = createUnreachableBackoff({ scope: "[t]", baseMs: 2000, maxMs: 10000, now: () => t });
    b.failed(new Error("down"));
    t += 5_000;
    b.failed(new Error("down"));
    t += 5_000;
    b.succeeded();
    b.succeeded();

    expect(log.info).toHaveBeenCalledOnce();
    expect(vi.mocked(log.info).mock.calls[0]![1]).toEqual({ failedTicks: 2, downMs: 10_000 });
    expect(b.nextDelayMs()).toBe(2000);

    // A second outage is announced again.
    b.failed(new Error("down"));
    expect(log.warn).toHaveBeenCalledTimes(2);
  });
});
