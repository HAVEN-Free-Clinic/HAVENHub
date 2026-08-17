// @vitest-environment jsdom
/**
 * ConfirmButton has a long history and every test here pins one chapter of it.
 *
 * Audit 14: the armed state auto-reset on a 3s timer. Three seconds is less than a
 * screen reader takes to announce the aria-live "Confirm?" label, let alone to then
 * move to the control and activate it, so a screen-reader user could never reach the
 * confirm step. Every destructive action in the app routes through this button, so
 * that made all of them uncompletable. The timer is gone; focus loss disarms instead.
 *
 * Audit 11 (#12): arming must not swap the DOM node, or the browser drops the focused
 * element and an AT user lands on <body> with no way back.
 *
 * Audit 10 (#78): the armed state must not revert to a live idle button while the
 * confirmed action is in flight, or a second click double-fires it.
 *
 * Bare createRoot + act(), following use-focus-trap.test.tsx: this repo has no
 * @testing-library/react.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConfirmButton } from "./confirm-button";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let mounted: { container: HTMLDivElement; root: Root } | null = null;
let submits = 0;

function mount(props: Partial<React.ComponentProps<typeof ConfirmButton>> = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      // preventDefault because jsdom does not implement real form submission; the
      // count is what the double-submit assertions read.
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submits += 1;
        }}
      >
        <ConfirmButton label="Remove" {...props} />
        <button type="button" data-testid="elsewhere">
          Elsewhere
        </button>
      </form>,
    ),
  );
  mounted = { container, root };
}

const confirmButton = () =>
  mounted!.container.querySelector<HTMLButtonElement>('button:not([data-testid="elsewhere"])')!;
const elsewhere = () => mounted!.container.querySelector<HTMLButtonElement>('[data-testid="elsewhere"]')!;

beforeEach(() => {
  submits = 0;
});

afterEach(() => {
  if (mounted) {
    const { container, root } = mounted;
    act(() => root.unmount());
    container.remove();
    mounted = null;
  }
  vi.useRealTimers();
});

describe("ConfirmButton arming", () => {
  it("arms on the first click without submitting", () => {
    mount();
    expect(confirmButton().textContent).toContain("Remove");
    expect(confirmButton().type).toBe("button");

    act(() => confirmButton().click());

    expect(confirmButton().textContent).toContain("Confirm?");
    expect(confirmButton().type).toBe("submit");
    expect(submits).toBe(0);
  });

  it("submits on the second click", () => {
    mount();
    act(() => confirmButton().click());
    act(() => confirmButton().click());
    expect(submits).toBe(1);
  });

  it("keeps the SAME DOM node when it arms, so focus survives (#12)", () => {
    mount();
    const before = confirmButton();
    before.focus();
    act(() => before.click());

    expect(confirmButton()).toBe(before);
    expect(document.activeElement).toBe(before);
  });
});

describe("ConfirmButton armed state does not expire (audit 14)", () => {
  it("is still armed long after the 3s window the old timer used", () => {
    vi.useFakeTimers();
    mount();
    act(() => confirmButton().click());
    expect(confirmButton().textContent).toContain("Confirm?");

    // Far past the old 3000ms auto-reset, and past any plausible replacement for it.
    act(() => vi.advanceTimersByTime(60_000));

    expect(confirmButton().textContent).toContain("Confirm?");
    expect(confirmButton().type).toBe("submit");
  });

  it("still submits after that wait, which is the step a screen-reader user could never reach", () => {
    vi.useFakeTimers();
    mount();
    act(() => confirmButton().click());
    act(() => vi.advanceTimersByTime(60_000));
    act(() => confirmButton().click());

    expect(submits).toBe(1);
  });
});

describe("ConfirmButton self-heal", () => {
  it("disarms when focus moves off the control", () => {
    mount();
    confirmButton().focus();
    act(() => confirmButton().click());
    expect(confirmButton().textContent).toContain("Confirm?");

    act(() => elsewhere().focus());

    expect(confirmButton().textContent).toContain("Remove");
    expect(confirmButton().type).toBe("button");
  });

  it("does not disarm on the blur caused by its own confirming click", () => {
    // The confirm click submits, which in the real app disables the button and makes
    // the browser blur it. If that blur disarmed us, the control would flip back to
    // its idle look mid-action, which is the state #78 exists to prevent.
    mount();
    confirmButton().focus();
    act(() => confirmButton().click());
    act(() => confirmButton().click());
    act(() => confirmButton().blur());

    expect(submits).toBe(1);
    expect(confirmButton().textContent).toContain("Confirm?");
  });
});
