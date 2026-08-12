// @vitest-environment jsdom
/**
 * Mounts BlockerGate with the probe stubbed, following flash-reader.test.tsx's
 * approach: a bare createRoot + act() mount, no testing-library. The probe's
 * own decision rule is blocker-probe.test.ts's job; this proves the wiring.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ProbeResult } from "./blocker-probe";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let probeResult: ProbeResult = { blocked: false };
const probeCalls = { count: 0 };

vi.mock("./blocker-probe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./blocker-probe")>();
  return {
    ...actual,
    probeContentBlocker: vi.fn(async () => {
      probeCalls.count += 1;
      return probeResult;
    }),
  };
});

vi.mock("posthog-js", () => ({ default: { capture: vi.fn() } }));

// Static import is safe and matches flash-reader.test.tsx: vitest hoists
// vi.mock above every import, so the mock is registered before this resolves.
import { BlockerGate } from "./blocker-gate";

let mounted: { container: HTMLDivElement; root: Root } | null = null;

async function mount(supportEmail = "help@example.org") {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<BlockerGate appId="abc123" supportEmail={supportEmail} />);
  });
  mounted = { container, root };
}

beforeEach(() => {
  probeResult = { blocked: false };
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
