import { describe, it, expect } from "vitest";
import { createEnqueueFlusher } from "./flush-on-enqueue";

describe("createEnqueueFlusher", () => {
  it("runs one drain per non-overlapping flush", async () => {
    let calls = 0;
    const { flushNow } = createEnqueueFlusher(async () => {
      calls++;
    });
    await flushNow();
    await flushNow();
    expect(calls).toBe(2);
  });

  it("collapses flushes that arrive during an in-flight drain into one re-run", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const drain = async () => {
      calls++;
      if (calls === 1) await gate; // park only the first drain
    };
    const { flushNow } = createEnqueueFlusher(drain);

    const a = flushNow(); // calls=1, parks on gate
    const b = flushNow(); // drain in flight -> marks dirty, returns
    const c = flushNow(); // still dirty, returns
    release(); // first drain completes -> loop sees dirty -> one more drain (calls=2)
    await Promise.all([a, b, c]);

    expect(calls).toBe(2);
  });

  it("schedule() does not throw outside a request scope", () => {
    const { schedule } = createEnqueueFlusher(async () => {});
    expect(() => schedule()).not.toThrow();
  });
});
