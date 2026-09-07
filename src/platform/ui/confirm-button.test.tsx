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

/**
 * The tree under test. Split out of `mount` so a test can RE-render it with
 * different props, which is how the `busy` cases below move the button in and
 * out of its in-flight state the way a parent component would.
 */
function wrap(props: Partial<React.ComponentProps<typeof ConfirmButton>> = {}) {
  return (
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
    </form>
  );
}

function mount(props: Partial<React.ComponentProps<typeof ConfirmButton>> = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(wrap(props)));
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

describe("ConfirmButton onConfirm (no surrounding form)", () => {
  it("runs the handler on the second click, not the first", () => {
    const onConfirm = vi.fn();
    mount({ onConfirm });

    act(() => confirmButton().click());
    expect(onConfirm).not.toHaveBeenCalled();
    expect(confirmButton().textContent).toContain("Confirm?");

    act(() => confirmButton().click());
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("never becomes a submit button, so it cannot post an ancestor form", () => {
    mount({ onConfirm: vi.fn() });
    expect(confirmButton().type).toBe("button");
    act(() => confirmButton().click());
    // Armed, but still not a submit: the form around it must stay untouched.
    expect(confirmButton().type).toBe("button");
    act(() => confirmButton().click());
    expect(submits).toBe(0);
  });

  it("disarms after confirming, so a third click does not fire again", () => {
    const onConfirm = vi.fn();
    mount({ onConfirm });
    act(() => confirmButton().click());
    act(() => confirmButton().click());
    expect(confirmButton().textContent).toContain("Remove");

    act(() => confirmButton().click());
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("keeps the same DOM node across arming, so focus survives", () => {
    mount({ onConfirm: vi.fn() });
    const before = confirmButton();
    before.focus();
    act(() => before.click());
    expect(confirmButton()).toBe(before);
    expect(document.activeElement).toBe(before);
  });

  it("disarms when focus leaves, with no timer involved", () => {
    const onConfirm = vi.fn();
    mount({ onConfirm });
    confirmButton().focus();
    act(() => confirmButton().click());
    expect(confirmButton().textContent).toContain("Confirm?");

    act(() => elsewhere().focus());

    expect(confirmButton().textContent).toContain("Remove");
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe("ConfirmButton busy (an asynchronous onConfirm)", () => {
  // Behind a form, useFormStatus disables the button for the length of the
  // action and a second click cannot double-fire it (#78). An onConfirm handler
  // gets no such signal, so `busy` is how the caller supplies one. Without it an
  // async handler -- the Schedule Builder's Remove buttons write over fetch --
  // would return to a live control the instant it was CALLED.
  it("disables the control while the action is in flight", () => {
    mount({ onConfirm: vi.fn(), busy: true });
    expect(confirmButton().disabled).toBe(true);
    expect(confirmButton().getAttribute("aria-busy")).toBe("true");
  });

  it("stays armed for the length of the action, then disarms when it settles", () => {
    const onConfirm = vi.fn();
    mount({ onConfirm, busy: false });
    act(() => confirmButton().click());
    act(() => confirmButton().click());
    expect(onConfirm).toHaveBeenCalledTimes(1);

    // The action is running: armed, disabled, spinner -- the same state the form
    // path shows, rather than a live idle button.
    act(() => mounted!.root.render(wrap({ onConfirm, busy: true })));
    expect(confirmButton().textContent).toContain("Confirm?");
    expect(confirmButton().disabled).toBe(true);

    // Settled.
    act(() => mounted!.root.render(wrap({ onConfirm, busy: false })));
    expect(confirmButton().textContent).toContain("Remove");
    expect(confirmButton().disabled).toBe(false);
  });

  // The blur that the browser produces when the button is disabled mid-action
  // must not read as "the user moved away" and flip the control back.
  it("does not disarm on the blur its own disabling causes", () => {
    const onConfirm = vi.fn();
    mount({ onConfirm, busy: false });
    confirmButton().focus();
    act(() => confirmButton().click());
    act(() => confirmButton().click());
    act(() => mounted!.root.render(wrap({ onConfirm, busy: true })));
    act(() => confirmButton().blur());

    expect(confirmButton().textContent).toContain("Confirm?");
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  // main's two onConfirm callers pass a synchronous handler and no `busy`, so
  // nothing would ever move `pending` for the effect to disarm on.
  it("still disarms immediately when the caller passes no busy flag", () => {
    const onConfirm = vi.fn();
    mount({ onConfirm });
    act(() => confirmButton().click());
    act(() => confirmButton().click());
    expect(confirmButton().textContent).toContain("Remove");
    expect(confirmButton().disabled).toBe(false);
  });

  it("is ignored behind a form, where useFormStatus already knows", () => {
    // No onConfirm: this button submits, and its in-flight state is the form's
    // to report. A stray busy prop must not disable it.
    mount({ busy: true });
    expect(confirmButton().disabled).toBe(false);
  });
});
