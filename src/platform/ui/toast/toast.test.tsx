// @vitest-environment jsdom
/**
 * Interaction tests for the toast viewport: auto-dismiss timing, the error
 * close button, the 3-visible/rest-queued cap, and live-region politeness.
 * Follows `combobox.test.tsx`'s approach (the one other component test in
 * this repo that drives real state changes): a bare `createRoot` + `act()`
 * mount, no testing-library, real DOM assertions.
 *
 * `ToastViewport` portals its content to `document.body` (see toast.tsx), so
 * assertions query `document`, not the local mount container.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ToastProvider, ToastViewport, useToast, type ToastInput } from "./toast";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Mirrors toast.tsx's own AUTO_DISMISS_MS (not exported; it is an
 *  implementation constant, not part of the module's public surface). */
const AUTO_DISMISS_MS = 4000;

let mounted: { container: HTMLDivElement; root: Root } | null = null;

/** A harness that exposes `useToast()` to the test via one button per tone,
 *  each pushing a distinguishable message so assertions can tell them apart. */
function Harness() {
  const toast = useToast();
  const push = (input: ToastInput) => () => toast(input);
  return (
    <div>
      <button data-action="success" onClick={push({ tone: "success", message: "Saved." })}>
        push success
      </button>
      <button
        data-action="error"
        onClick={push({ tone: "error", message: "Something broke." })}
      >
        push error
      </button>
      <button
        data-action="warning"
        onClick={push({ tone: "warning", message: "Heads up." })}
      >
        push warning
      </button>
      <button data-action="info" onClick={push({ tone: "info", message: "FYI." })}>
        push info
      </button>
    </div>
  );
}

function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <ToastProvider>
        <Harness />
        <ToastViewport />
      </ToastProvider>,
    );
  });
  // ToastViewport defers its first portal render by one tick past mount
  // (a zero-delay setTimeout, so it stays hydration-safe: `mounted` starts
  // false on both the server and the client's initial render, only flipping
  // true in a post-mount effect). Flush that tick so the assertions below
  // see the viewport immediately, the same way the auto-dismiss timers are
  // advanced explicitly rather than relying on real time.
  act(() => {
    vi.advanceTimersByTime(0);
  });
  mounted = { container, root };
  return container;
}

function click(container: HTMLElement, selector: string, times = 1) {
  const el = container.querySelector(selector) as HTMLButtonElement;
  for (let i = 0; i < times; i++) {
    act(() => {
      el.click();
    });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  if (mounted) {
    act(() => {
      mounted!.root.unmount();
    });
    mounted.container.remove();
    mounted = null;
  }
  vi.useRealTimers();
});

describe("auto-dismiss vs. persistent toasts", () => {
  it("auto-dismisses a success toast after ~4s", () => {
    const container = mount();
    click(container, '[data-action="success"]');

    expect(document.querySelector('[role="status"]')?.textContent).toContain("Saved.");

    act(() => {
      vi.advanceTimersByTime(AUTO_DISMISS_MS);
    });

    expect(document.querySelector('[role="status"]')).toBeNull();
  });

  it("does not auto-dismiss an error toast, even long after the auto-dismiss window", () => {
    const container = mount();
    click(container, '[data-action="error"]');

    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Something broke.");

    act(() => {
      vi.advanceTimersByTime(AUTO_DISMISS_MS * 10);
    });

    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Something broke.");
  });
});

describe("error toast close button", () => {
  it("renders a close button and dismisses on click", () => {
    const container = mount();
    click(container, '[data-action="error"]');

    const closeButton = document.querySelector(
      '[role="alert"] button[aria-label="Dismiss notification"]',
    );
    expect(closeButton).not.toBeNull();

    act(() => {
      (closeButton as HTMLButtonElement).click();
    });

    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it("does not render a close button on an auto-dismissing success toast", () => {
    const container = mount();
    click(container, '[data-action="success"]');

    expect(
      document.querySelector('[role="status"] button[aria-label="Dismiss notification"]'),
    ).toBeNull();
  });
});

describe("visible cap and queueing", () => {
  it("shows only 3 of 4 queued toasts", () => {
    const container = mount();
    click(container, '[data-action="warning"]', 4);

    const rendered = document.querySelectorAll('[role="alert"], [role="status"]');
    expect(rendered.length).toBe(3);
  });

  it("promotes the queued 4th toast once a visible one is dismissed", () => {
    const container = mount();
    click(container, '[data-action="warning"]', 4);
    expect(document.querySelectorAll('[role="alert"], [role="status"]').length).toBe(3);

    // Dismiss one of the three visible warning toasts by clicking its close button.
    const closeButtons = document.querySelectorAll('button[aria-label="Dismiss notification"]');
    act(() => {
      (closeButtons[0] as HTMLButtonElement).click();
    });

    // A slot freed up, so the previously-queued 4th toast should now be visible.
    expect(document.querySelectorAll('[role="alert"], [role="status"]').length).toBe(3);
  });
});

describe("live region politeness", () => {
  it("announces success politely (role=status) and error assertively (role=alert)", () => {
    const container = mount();
    click(container, '[data-action="success"]');
    click(container, '[data-action="error"]');

    const status = document.querySelector('[role="status"]');
    const alertEl = document.querySelector('[role="alert"]');

    expect(status?.textContent).toContain("Saved.");
    expect(alertEl?.textContent).toContain("Something broke.");
  });

  it("announces warning politely (role=status), matching alert.tsx's non-error default", () => {
    const container = mount();
    click(container, '[data-action="warning"]');

    expect(document.querySelector('[role="status"]')?.textContent).toContain("Heads up.");
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });
});
