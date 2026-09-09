// @vitest-environment jsdom
/**
 * The clipboard genuinely fails -- an insecure origin leaves
 * `navigator.clipboard` undefined, and `writeText` rejects on a denied
 * permission. These drive both, because the only real bug this component can
 * have is claiming a copy that did not happen.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CopyButton } from "./copy-button";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let mounted: { container: HTMLDivElement; root: Root } | null = null;

function mount(node: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mounted = { container, root };
  return container;
}

/** jsdom ships no clipboard, so each test installs the one it wants to test. */
function setClipboard(value: { writeText: (t: string) => Promise<void> } | undefined) {
  Object.defineProperty(navigator, "clipboard", {
    value,
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  if (mounted) {
    const { container, root } = mounted;
    act(() => root.unmount());
    container.remove();
    mounted = null;
  }
  setClipboard(undefined);
  vi.useRealTimers();
});

const button = (c: HTMLElement) => c.querySelector("button")!;
const click = async (c: HTMLElement) => {
  await act(async () => {
    button(c).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};

describe("CopyButton", () => {
  it("writes the value and reports it, in the label and to a screen reader", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    const c = mount(<CopyButton value="hello@example.com" />);
    expect(button(c).textContent).toBe("Copy");
    await click(c);
    expect(writeText).toHaveBeenCalledWith("hello@example.com");
    expect(button(c).textContent).toBe("Copied");
    // The button's own label change is not reliably re-announced while it still
    // has focus, which is exactly when it changes.
    expect(c.querySelector('[role="status"]')!.textContent).toBe("Copied to clipboard");
  });

  it("never says Copied when the write was refused", async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error("denied")) });
    const c = mount(<CopyButton value="x" />);
    await click(c);
    expect(button(c).textContent).toBe("Copy");
    expect(c.querySelector('[role="status"]')!.textContent).toBe("");
  });

  it("never says Copied on an insecure origin, where there is no clipboard at all", async () => {
    // navigator.clipboard is undefined there, so the call would throw a
    // TypeError before any promise existed -- hence the explicit guard.
    setClipboard(undefined);
    const c = mount(<CopyButton value="x" />);
    await click(c);
    expect(button(c).textContent).toBe("Copy");
  });

  it("stays silent about a failure when the caller gave it nothing to say", async () => {
    // The value is on screen in a selectable field: a refused clipboard costs
    // one drag and is not worth interrupting for.
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error("denied")) });
    const c = mount(<CopyButton value="x" />);
    await click(c);
    expect(c.querySelector('[role="alert"]')).toBeNull();
  });

  it("speaks up when the value is not recoverable", async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error("denied")) });
    const c = mount(<CopyButton value="x" errorMessage="Select the link above and copy it manually." />);
    expect(c.querySelector('[role="alert"]')).toBeNull();
    await click(c);
    expect(c.querySelector('[role="alert"]')!.textContent).toBe(
      "Select the link above and copy it manually.",
    );
  });

  it("clears a success after two seconds but leaves a failure standing", async () => {
    // "Copied" is a receipt for something that already happened. A failure is a
    // thing still to do, and the reader may look back long after any timer --
    // the invite panel's whole point is that leaving the page loses the link.
    vi.useFakeTimers();
    const ok = { writeText: vi.fn().mockResolvedValue(undefined) };
    setClipboard(ok);
    const c = mount(<CopyButton value="x" errorMessage="Copy it manually." />);
    await click(c);
    expect(button(c).textContent).toBe("Copied");
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(button(c).textContent).toBe("Copy");

    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error("denied")) });
    await click(c);
    expect(c.querySelector('[role="alert"]')).not.toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(c.querySelector('[role="alert"]')).not.toBeNull();
  });
});
