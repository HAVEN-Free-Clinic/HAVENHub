// @vitest-environment jsdom
/**
 * WithdrawnToast is the one flash param this migration deliberately keeps out
 * of the flash.ts registry (see that file's own doc comment): my-info/page.tsx's
 * `?withdrawn=<count>` only ever meant to show a banner when the count is
 * greater than zero, and the registry has no way to express "fire, but only
 * above a threshold." These tests pin that zero-suppression, plus the actual
 * toast text, using the same bare createRoot + act() harness toast.test.tsx
 * already established for this module (no testing-library in this repo).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ToastProvider, ToastViewport } from "@/platform/ui/toast/toast";
import { WithdrawnToast } from "./withdrawn-toast";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let mounted: { container: HTMLDivElement; root: Root } | null = null;

function mount(withdrawn: number | undefined) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <ToastProvider>
        <WithdrawnToast withdrawn={withdrawn} />
        <ToastViewport />
      </ToastProvider>,
    );
  });
  // ToastViewport's own hydration-safe mount flag flips one tick after mount
  // (see toast.tsx); flush it so the assertions below see the portal.
  act(() => {
    vi.advanceTimersByTime(0);
  });
  mounted = { container, root };
  return container;
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

describe("WithdrawnToast", () => {
  it("pushes the exact pre-migration text when withdrawn is 1 (singular)", () => {
    mount(1);
    expect(document.querySelector('[role="status"]')?.textContent).toContain(
      "Withdrawn from 1 volunteer assignment this term.",
    );
  });

  it("pushes the plural form when withdrawn is greater than 1", () => {
    mount(3);
    expect(document.querySelector('[role="status"]')?.textContent).toContain(
      "Withdrawn from 3 volunteer assignments this term.",
    );
  });

  it("does not push a toast when withdrawn is 0", () => {
    // The zero-suppression this component exists to preserve: my-info/page.tsx's
    // withdrawAction redirects with ?withdrawn=0 when there is nothing to
    // withdraw (e.g. no active term), and the pre-migration inline Alert never
    // rendered for that case.
    mount(0);
    expect(document.querySelector('[role="status"]')).toBeNull();
  });

  it("does not push a toast when withdrawn is undefined", () => {
    mount(undefined);
    expect(document.querySelector('[role="status"]')).toBeNull();
  });
});
