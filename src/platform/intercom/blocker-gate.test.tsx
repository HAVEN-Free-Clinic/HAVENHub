// @vitest-environment jsdom
/**
 * Mounts BlockerGate with the probe stubbed, following flash-reader.test.tsx's
 * approach: a bare createRoot + act() mount, no testing-library. The probe's
 * own decision rule is blocker-probe.test.ts's job; this proves the wiring.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ProbeResult } from "./blocker-probe";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let probeResult: ProbeResult = { blocked: false };
let probeError: Error | null = null;
const probeCalls = { count: 0 };

/**
 * Set by deferNextProbe() to hold the NEXT probe open, so a test can act while
 * one is genuinely in flight. Cleared as soon as it is handed out, so later
 * probes settle immediately from probeResult as usual.
 */
let deferredProbe: Promise<ProbeResult> | null = null;

function deferNextProbe(): (result: ProbeResult) => void {
  let settle!: (result: ProbeResult) => void;
  deferredProbe = new Promise<ProbeResult>((resolve) => {
    settle = resolve;
  });
  return settle;
}

vi.mock("./blocker-probe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./blocker-probe")>();
  return {
    ...actual,
    probeContentBlocker: vi.fn(async () => {
      probeCalls.count += 1;
      if (probeError) throw probeError;
      if (deferredProbe) {
        const pending = deferredProbe;
        deferredProbe = null;
        return pending;
      }
      return probeResult;
    }),
  };
});

vi.mock("posthog-js", () => ({ default: { capture: vi.fn() } }));

// Static import is safe and matches flash-reader.test.tsx: vitest hoists
// vi.mock above every import, so the mock is registered before this resolves.
import { BlockerGate } from "./blocker-gate";

let mounted: { container: HTMLDivElement; root: Root } | null = null;

const recheckButton = () =>
  document.querySelector<HTMLButtonElement>('[data-testid="blocker-recheck"]');

async function mount(supportEmail = "help@example.org", { strict = false } = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const gate = <BlockerGate appId="abc123" supportEmail={supportEmail} />;
  await act(async () => {
    root.render(strict ? <StrictMode>{gate}</StrictMode> : gate);
  });
  mounted = { container, root };
}

beforeEach(() => {
  probeResult = { blocked: false };
  probeError = null;
  deferredProbe = null;
  probeCalls.count = 0;
});

afterEach(() => {
  if (mounted) {
    const { container, root } = mounted;
    act(() => root.unmount());
    container.remove();
    mounted = null;
  }
  document.body.style.overflow = "";
});

describe("BlockerGate", () => {
  it("renders nothing when no blocker is breaking the Messenger", async () => {
    await mount();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("renders a modal dialog when a blocker is detected", async () => {
    probeResult = { blocked: true, failed: ["widget"] };
    await mount();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
  });

  it("offers no way to dismiss it, because the whole point is that it blocks", async () => {
    probeResult = { blocked: true, failed: ["widget"] };
    await mount();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.querySelector('[aria-label="Close"]')).toBeNull();
    // Escape must not clear it either.
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("locks body scroll while it is up, so the page behind cannot be used", async () => {
    probeResult = { blocked: true, failed: ["token"] };
    await mount();
    expect(document.body.style.overflow).toBe("hidden");
  });

  it("clears itself when a re-check finds the blocker gone", async () => {
    probeResult = { blocked: true, failed: ["token"] };
    await mount();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    probeResult = { blocked: false };
    const button = document.querySelector<HTMLButtonElement>('[data-testid="blocker-recheck"]');
    expect(button).not.toBeNull();
    await act(async () => {
      button?.click();
    });

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.style.overflow).not.toBe("hidden");
  });

  it("stays up when a re-check still finds the blocker", async () => {
    probeResult = { blocked: true, failed: ["token"] };
    await mount();
    const button = document.querySelector<HTMLButtonElement>('[data-testid="blocker-recheck"]');
    await act(async () => {
      button?.click();
    });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("ignores a competing re-check while one is in flight, so a stale result cannot land last", async () => {
    probeResult = { blocked: true, failed: ["token"] };
    await mount();
    expect(probeCalls.count).toBe(1);

    // The member presses the button while still blocked, and that probe hangs.
    const settle = deferNextProbe();
    await act(async () => {
      recheckButton()?.click();
    });
    expect(probeCalls.count).toBe(2);

    // Now they really do turn the blocker off, leave the tab, and come back.
    // Before the fix the focus listener started a second probe and whichever
    // settled last won: the stale "still blocked" one could land after the
    // clean one and put the gate back on top of the page they had moved to.
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(probeCalls.count).toBe(2);

    await act(async () => {
      settle({ blocked: true, failed: ["token"] });
    });
    expect(probeCalls.count).toBe(2);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    // The in-flight guard must not leave the only button disabled either.
    expect(recheckButton()?.disabled).toBe(false);
  });

  it("announces every re-check outcome, because this dialog cannot be left", async () => {
    probeResult = { blocked: true, failed: ["token"] };
    await mount();
    const live = document.querySelector('[role="status"]');
    expect(live?.getAttribute("aria-live")).toBe("polite");

    const settle = deferNextProbe();
    await act(async () => {
      recheckButton()?.click();
    });
    expect(live?.textContent).toMatch(/checking/i);

    await act(async () => {
      settle({ blocked: true, failed: ["token"] });
    });
    expect(live?.textContent).toMatch(/still blocked/i);

    probeResult = { blocked: false };
    await act(async () => {
      recheckButton()?.click();
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    // The same node, with new text. A screen reader announces a live region's
    // text CHANGING, and a dialog that simply vanishes is no feedback at all to
    // someone who cannot see it.
    expect(document.querySelector('[role="status"]')).toBe(live);
    expect(live?.textContent).toMatch(/nothing is blocked/i);
  });

  it("re-enables the button when a re-check throws, rather than stranding the only control", async () => {
    probeResult = { blocked: true, failed: ["token"] };
    await mount();
    probeError = new Error("probe exploded");
    await act(async () => {
      recheckButton()?.click();
    });
    // A probe that could not finish proves nothing, so the gate stands, but the
    // member must still be able to try again.
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(recheckButton()?.disabled).toBe(false);
    expect(document.querySelector('[role="status"]')?.textContent).toMatch(/could not finish/i);
  });

  it("offers a mailto escape for anyone who cannot turn their blocker off", async () => {
    probeResult = { blocked: true, failed: ["widget"] };
    await mount("help@example.org");
    const link = document.querySelector('a[href^="mailto:"]');
    expect(link?.getAttribute("href")).toBe("mailto:help@example.org");
  });

  it("probes exactly once per page load, even when visibilitychange fires again after it settles", async () => {
    await mount();
    // The initial mount effect has already run the probe once.
    expect(probeCalls.count).toBe(1);

    // A second visibilitychange after the probe has settled must be a no-op:
    // this is the settled.current guard in blocker-gate.tsx, and the whole
    // point of this test is to catch a regression that deletes it.
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(probeCalls.count).toBe(1);
  });

  it("still fires under StrictMode, and still probes only once", async () => {
    // next dev and the Playwright web server both run StrictMode, which mounts,
    // cleans up, and mounts again. Refs survive that cycle, so a boolean
    // "already started" guard let the first mount claim the only probe and the
    // cleanup discard its result: the gate never appeared in dev, and the
    // manual verification step would have reported a false negative.
    probeResult = { blocked: true, failed: ["widget"] };
    await mount("help@example.org", { strict: true });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(probeCalls.count).toBe(1);
  });

  it("defers the probe while the tab is hidden, then runs it exactly once after it becomes visible", async () => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    try {
      await mount();
      expect(probeCalls.count).toBe(0);

      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "visible",
      });
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });

      expect(probeCalls.count).toBe(1);
    } finally {
      // Fall back to jsdom's own prototype getter, which reports "visible".
      delete (document as unknown as { visibilityState?: string }).visibilityState;
    }
  });
});
