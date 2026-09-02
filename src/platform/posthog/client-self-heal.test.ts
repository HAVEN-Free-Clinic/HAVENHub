// @vitest-environment jsdom
/**
 * Cover for the one-reload self-heal, and specifically for the ordering trap it
 * sits in.
 *
 * `recoverOnce` captures a recovery event and then immediately reloads the page.
 * A default `posthog.capture` is queued and flushed later, so the reload on the
 * next line destroys it. That failure is invisible in production: the member is
 * still recovered, the event simply never arrives, and the absence reads as
 * "the heal never fired" instead of "we cannot tell". Across 90 days this
 * project recorded zero `client_*_recovered` events of any kind.
 *
 * So the assertions below are mostly about *how* the capture is sent, not that
 * it happened.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { capture } = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock("posthog-js", () => ({ default: { capture } }));

import posthog from "posthog-js";
import { recoverOnce, type SelfHeal } from "./client-self-heal";

const HEAL: SelfHeal = {
  decide: (_error, alreadyRecovered) => (alreadyRecovered ? "already-recovered" : "reload"),
  storageKey: "haven:test-heal-recovered",
  recoveredEvent: "client_test_recovered",
};

const reload = vi.fn();
/** Everything capture() did before reload() was called, in order. */
let callsBeforeReload = 0;

beforeEach(() => {
  sessionStorage.clear();
  capture.mockClear();
  reload.mockReset();
  callsBeforeReload = 0;
  reload.mockImplementation(() => {
    callsBeforeReload = capture.mock.calls.length;
  });
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, reload },
  });
});

afterEach(() => {
  sessionStorage.clear();
});

describe("recoverOnce", () => {
  it("reloads once for a recognised error and records that it did", () => {
    expect(recoverOnce(HEAL, new Error("boom"))).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith("client_test_recovered", undefined, expect.anything());
  });

  /**
   * The load-bearing one. A queued capture never leaves the page, because the
   * reload on the next line kills it. Sending instantly over sendBeacon is what
   * makes the event survive, and nothing else in the suite notices if it stops.
   */
  it("sends the recovery event in a way that survives the reload", () => {
    recoverOnce(HEAL, new Error("boom"));

    const [, , options] = capture.mock.calls[0];
    expect(options).toMatchObject({ send_instantly: true, transport: "sendBeacon" });
  });

  it("captures BEFORE it reloads, or there is nothing left to send", () => {
    recoverOnce(HEAL, new Error("boom"));

    expect(callsBeforeReload).toBe(1);
  });

  it("spends only one reload per tab for a given heal", () => {
    expect(recoverOnce(HEAL, new Error("boom"))).toBe(true);
    // Second crash of the same class in the same tab: reloading again would
    // only loop, since the first reload evidently did not fix it.
    expect(recoverOnce(HEAL, new Error("boom"))).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("does nothing for an error the heal does not recognise", () => {
    const unrelated: SelfHeal = { ...HEAL, decide: () => "unrelated" };

    expect(recoverOnce(unrelated, new Error("boom"))).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });

  it("keeps a heal's reload out of a sibling heal's budget", () => {
    const other: SelfHeal = { ...HEAL, storageKey: "haven:other-heal-recovered" };

    expect(recoverOnce(HEAL, new Error("boom"))).toBe(true);
    expect(recoverOnce(other, new Error("boom"))).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("declines rather than looping when sessionStorage cannot be read", () => {
    // Safari in private mode throws here. A missed reload is a page the member
    // reloads by hand; an unbounded one is a loop.
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });

    expect(recoverOnce(HEAL, new Error("boom"))).toBe(false);
    expect(reload).not.toHaveBeenCalled();

    getItem.mockRestore();
  });

  it("does not claim a reload it could not record", () => {
    // If the write fails we cannot enforce the once-only budget, so we must not
    // reload at all rather than risk reloading on every crash.
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });

    expect(recoverOnce(HEAL, new Error("boom"))).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(posthog.capture).not.toHaveBeenCalled();

    setItem.mockRestore();
  });
});
