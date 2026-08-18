// @vitest-environment jsdom
/**
 * Interaction tests for the palette's global Cmd+K listener. It registers in a
 * useEffect, and command-palette.test.tsx renders to static markup, so no
 * effect ever runs there and the listener has never had direct coverage.
 *
 * The keyless-keydown case is the reason this file exists. The listener is
 * mounted on every page for every signed-in person, and browser extensions,
 * password managers, and IME shims dispatch synthetic keydowns that carry no
 * `key` at all, which made the opening `e.key.toLowerCase()` throw a TypeError
 * per event straight into error tracking.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CommandPalette } from "./command-palette";
import type { NavModule } from "@/platform/modules/nav";

// CommandPalette is a client component; useRouter needs a stub outside the app.
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ITEMS: NavModule[] = [
  { id: "schedule", title: "Schedule", href: "/schedule", nav: [{ label: "Builder", href: "/schedule/builder" }] },
];

let mounted: { container: HTMLDivElement; root: Root } | null = null;

function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<CommandPalette items={ITEMS} />));
  mounted = { container, root };
}

afterEach(() => {
  if (mounted) {
    const { container, root } = mounted;
    act(() => root.unmount());
    container.remove();
    mounted = null;
  }
});

/** The dialog renders through a portal, so look for it on the whole document. */
function paletteOpen(): boolean {
  return document.querySelector('[role="dialog"][aria-modal="true"][aria-label="Search"]') !== null;
}

function press(init: KeyboardEventInit) {
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
  });
}

describe("CommandPalette global shortcut", () => {
  // The positive control, and the reason it is first: without it the
  // keyless-keydown case below would pass just as happily against a listener
  // that never registered at all.
  it("opens on Cmd+K", () => {
    mount();
    expect(paletteOpen()).toBe(false);
    press({ key: "k", metaKey: true });
    expect(paletteOpen()).toBe(true);
  });

  // Shift or Caps Lock reports the key as "K". Comparing both cases is what
  // replaced the toLowerCase() call, so it needs to stay covered.
  it("opens on Ctrl+Shift+K, where the key arrives uppercased", () => {
    mount();
    press({ key: "K", ctrlKey: true, shiftKey: true });
    expect(paletteOpen()).toBe(true);
  });

  it("leaves an unmodified k alone", () => {
    mount();
    press({ key: "k" });
    expect(paletteOpen()).toBe(false);
  });

  // A plain Event has no `key`, which is exactly the shape an extension or IME
  // shim dispatches. jsdom reports a throw inside a listener as a window
  // "error" event rather than rethrowing out of dispatchEvent, so a bare
  // not.toThrow() would pass either way; watch the window instead.
  it("ignores a keydown that carries no key instead of throwing", () => {
    mount();
    const onError = vi.fn();
    window.addEventListener("error", onError);
    try {
      act(() => {
        document.dispatchEvent(new Event("keydown", { bubbles: true }));
      });
    } finally {
      window.removeEventListener("error", onError);
    }
    expect(onError).not.toHaveBeenCalled();
    expect(paletteOpen()).toBe(false);
  });
});
