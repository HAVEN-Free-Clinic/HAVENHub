// @vitest-environment jsdom
/**
 * Covers the trap extracted from Modal, which never had direct tests of its
 * own. The blur-to-body case is the one that matters most: it is the #79 fix,
 * and it is the reason this logic is shared rather than copied.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useFocusTrap } from "./use-focus-trap";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Panel({ active }: { active: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, active);
  return (
    <div ref={ref} tabIndex={-1}>
      <button type="button" data-testid="first">first</button>
      <button type="button" data-testid="last">last</button>
    </div>
  );
}

let mounted: { container: HTMLDivElement; root: Root } | null = null;

function mount(active: boolean) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<Panel active={active} />));
  mounted = { container, root };
}

function press(shiftKey: boolean) {
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true }));
  });
}

const byId = (id: string) => document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);

afterEach(() => {
  if (mounted) {
    const { container, root } = mounted;
    act(() => root.unmount());
    container.remove();
    mounted = null;
  }
});

describe("useFocusTrap", () => {
  it("wraps Tab from the last focusable back to the first", () => {
    mount(true);
    byId("last")?.focus();
    press(false);
    expect(document.activeElement).toBe(byId("first"));
  });

  it("wraps Shift+Tab from the first focusable back to the last", () => {
    mount(true);
    byId("first")?.focus();
    press(true);
    expect(document.activeElement).toBe(byId("last"));
  });

  it("pulls focus back in when the browser has blurred to body (the #79 case)", () => {
    mount(true);
    // What happens when the focused control becomes disabled mid-transition.
    (document.activeElement as HTMLElement | null)?.blur();
    document.body.focus();
    press(false);
    expect(document.activeElement).toBe(byId("first"));
  });

  it("does nothing while inactive, so a closed dialog does not capture Tab", () => {
    mount(false);
    byId("last")?.focus();
    press(false);
    expect(document.activeElement).toBe(byId("last"));
  });
});
