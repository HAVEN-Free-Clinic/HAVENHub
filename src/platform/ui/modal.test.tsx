// @vitest-environment jsdom
/**
 * Guards Modal's effect ORDER, which nothing else in the repo does.
 *
 * Modal captures previouslyFocused from document.activeElement in its own
 * effect, and useFocusTrap moves focus into the panel. React runs effects in
 * declaration order, so if the trap were declared first, Modal would capture
 * the panel itself (tabIndex={-1} makes it focusable) and focus restore on
 * close would silently do nothing, for every dialog in the app. That went
 * wrong once already on this branch and was caught only by reading the diff:
 * the sole guard was a code comment, and modal.tsx had no test file at all.
 *
 * Bare createRoot + act(), following use-focus-trap.test.tsx: this repo has no
 * @testing-library/react.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Modal } from "./modal";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" data-testid="trigger" onClick={() => setOpen(true)}>
        Open
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="Test dialog">
        <button type="button" data-testid="inside">
          Inside
        </button>
      </Modal>
    </>
  );
}

let mounted: { container: HTMLDivElement; root: Root } | null = null;

function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<Harness />));
  mounted = { container, root };
}

const byTestId = (id: string) => document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const closeButton = () => document.querySelector<HTMLButtonElement>('[aria-label="Close"]');

afterEach(() => {
  if (mounted) {
    const { container, root } = mounted;
    act(() => root.unmount());
    container.remove();
    mounted = null;
  }
  document.body.style.overflow = "";
});

describe("Modal", () => {
  it("moves focus into the panel when it opens", () => {
    mount();
    act(() => byTestId("trigger")?.click());
    expect(dialog()).not.toBeNull();
    expect(document.activeElement).toBe(dialog());
  });

  it("restores focus to the control that opened it when it closes", () => {
    mount();
    const trigger = byTestId("trigger");
    trigger?.focus();
    expect(document.activeElement).toBe(trigger);

    act(() => trigger?.click());
    // Focus is in the dialog, so whatever Modal captured had to be captured
    // BEFORE this happened.
    expect(document.activeElement).toBe(dialog());

    act(() => closeButton()?.click());
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
