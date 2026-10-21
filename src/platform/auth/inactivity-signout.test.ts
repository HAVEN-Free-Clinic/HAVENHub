import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SIGN_OUT_RETRY_MS, signOutUntilDone } from "./inactivity-signout";

const network = { onLine: true };
const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
const win = new EventTarget();

beforeEach(() => {
  vi.useFakeTimers();
  network.onLine = true;
  doc.visibilityState = "visible";
  vi.stubGlobal("navigator", network);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", win);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const deadNetwork = () => Promise.reject(new TypeError("Failed to fetch"));

describe("signOutUntilDone", () => {
  it("signs out at once when the network is up", async () => {
    const signOut = vi.fn().mockResolvedValue(undefined);
    signOutUntilDone(signOut);
    await vi.advanceTimersByTimeAsync(SIGN_OUT_RETRY_MS * 3);
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it("does not try while the browser reports offline, then signs out on the online event", async () => {
    network.onLine = false;
    const signOut = vi.fn().mockResolvedValue(undefined);
    signOutUntilDone(signOut);
    await vi.advanceTimersByTimeAsync(SIGN_OUT_RETRY_MS * 3);
    expect(signOut).not.toHaveBeenCalled();

    network.onLine = true;
    win.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it("retries on the interval after a failed fetch until one succeeds", async () => {
    const signOut = vi
      .fn()
      .mockImplementationOnce(deadNetwork)
      .mockImplementationOnce(deadNetwork)
      .mockResolvedValue(undefined);
    signOutUntilDone(signOut);
    await vi.advanceTimersByTimeAsync(SIGN_OUT_RETRY_MS * 5);
    expect(signOut).toHaveBeenCalledTimes(3);
  });

  it("retries when the tab is shown again", async () => {
    const signOut = vi.fn().mockImplementationOnce(deadNetwork).mockResolvedValue(undefined);
    signOutUntilDone(signOut);
    await vi.advanceTimersByTimeAsync(0);

    doc.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(signOut).toHaveBeenCalledTimes(2);
  });

  it("starts no second attempt while one is in flight", async () => {
    const signOut = vi.fn().mockReturnValue(new Promise(() => {}));
    signOutUntilDone(signOut);
    win.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(SIGN_OUT_RETRY_MS * 3);
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it("stops retrying once stopped", async () => {
    const signOut = vi.fn(deadNetwork);
    const stop = signOutUntilDone(signOut);
    await vi.advanceTimersByTimeAsync(0);
    stop();

    win.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(SIGN_OUT_RETRY_MS * 3);
    expect(signOut).toHaveBeenCalledTimes(1);
  });
});
