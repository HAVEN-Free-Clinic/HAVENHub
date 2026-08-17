// @vitest-environment jsdom
/**
 * Covers the trap extracted from Modal, which never had direct tests of its
 * own. The blur-to-body case is the one that matters most: it is the #79 fix,
 * and it is the reason this logic is shared rather than copied.
 *
 * The last three cases are audit 14: the focusable set counted nodes that cannot
 * take focus (hidden inputs, disabled controls), which silently mis-picks `first`
 * and `last`; and an empty set made the trap stand down entirely, at exactly the
 * moment a trap is needed (a one-button dialog whose button disables itself for
 * the duration of its own submit).
 */
import { afterEach, describe, expect, it } from "vitest";
import { act, useRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useFocusTrap } from "./use-focus-trap";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Panel({ active, children }: { active: boolean; children?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, active);
  return (
    <div ref={ref} tabIndex={-1} data-testid="panel">
      {children ?? (
        <>
          <button type="button" data-testid="first">first</button>
          <button type="button" data-testid="last">last</button>
        </>
      )}
    </div>
  );
}

let mounted: { container: HTMLDivElement; root: Root } | null = null;

function mount(active: boolean, children?: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<Panel active={active}>{children}</Panel>));
  mounted = { container, root };
}

function press(shiftKey: boolean) {
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true }));
  });
}

const byId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

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

describe("useFocusTrap focusable set (audit 14)", () => {
  it("does not treat a trailing hidden input as the last focusable", () => {
    // Every server-action form in this app posts hidden id fields, so a panel whose
    // markup ends in one is the common case, not a contrived one. Counting it made
    // Shift+Tab wrap onto a node that cannot take focus, so focus simply did not move.
    mount(
      true,
      <>
        <button type="button" data-testid="first">first</button>
        <button type="button" data-testid="last">last</button>
        <input type="hidden" name="personId" value="p1" readOnly data-testid="hidden" />
      </>,
    );
    byId("first")?.focus();
    press(true);
    expect(document.activeElement).toBe(byId("last"));
  });

  it("does not treat a trailing disabled control as the last focusable", () => {
    mount(
      true,
      <>
        <button type="button" data-testid="first">first</button>
        <button type="button" data-testid="last">last</button>
        <input disabled data-testid="off" />
      </>,
    );
    byId("first")?.focus();
    press(true);
    expect(document.activeElement).toBe(byId("last"));
  });

  it("keeps focus in the panel when its only control has disabled itself", () => {
    // A one-button confirm dialog during its own submit: the button is disabled, the
    // browser has already blurred to <body>. Standing down here handed Tab to the
    // browser, which walked into the scroll-locked page behind the scrim.
    mount(
      true,
      <button type="button" disabled data-testid="only">
        Saving...
      </button>,
    );
    (document.activeElement as HTMLElement | null)?.blur();
    document.body.focus();
    expect(document.activeElement).toBe(document.body);

    press(false);

    expect(document.activeElement).toBe(byId("panel"));
  });
});
