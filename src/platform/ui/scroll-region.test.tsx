// @vitest-environment jsdom
/**
 * ScrollRegion only takes a tab stop while there is genuinely something
 * off-screen, so these tests drive scrollWidth/clientWidth directly: jsdom does
 * no layout, and both are 0 there unless stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ScrollRegion } from "./scroll-region";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let mounted: { container: HTMLDivElement; root: Root } | null = null;

/** jsdom has no ResizeObserver; the component only needs it to not throw. */
class FakeResizeObserver {
  observe() {}
  disconnect() {}
}

/** Force the overflow answer for every element rendered in this test. */
function stubOverflow({ scrollWidth, clientWidth }: { scrollWidth: number; clientWidth: number }) {
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
    configurable: true,
    get: () => scrollWidth,
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => clientWidth,
  });
}

function mount(props: Partial<React.ComponentProps<typeof ScrollRegion>> = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <ScrollRegion {...props}>
        <table />
      </ScrollRegion>,
    );
  });
  mounted = { container, root };
  return container.firstElementChild as HTMLElement;
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});

afterEach(() => {
  if (mounted) {
    act(() => mounted!.root.unmount());
    mounted.container.remove();
    mounted = null;
  }
  vi.unstubAllGlobals();
});

describe("ScrollRegion", () => {
  it("takes a tab stop when content overflows, so a keyboard can scroll it", () => {
    stubOverflow({ scrollWidth: 900, clientWidth: 400 });
    const el = mount();
    expect(el.getAttribute("tabindex")).toBe("0");
    expect(el.getAttribute("role")).toBe("group");
  });

  it("takes NO tab stop when everything already fits", () => {
    // ~46 tables render through this; a stop on each of them that scrolls
    // nowhere is 46 dead stops for every keyboard user.
    stubOverflow({ scrollWidth: 400, clientWidth: 400 });
    const el = mount();
    expect(el.getAttribute("tabindex")).toBeNull();
    expect(el.getAttribute("role")).toBeNull();
  });

  it("announces its name when one is given", () => {
    stubOverflow({ scrollWidth: 900, clientWidth: 400 });
    const el = mount({ label: "Master compliance roster" });
    expect(el.getAttribute("aria-label")).toBe("Master compliance roster");
  });

  it("is still reachable without a name, because unreachable beats unnamed", () => {
    stubOverflow({ scrollWidth: 900, clientWidth: 400 });
    const el = mount();
    expect(el.getAttribute("tabindex")).toBe("0");
    expect(el.getAttribute("aria-label")).toBeNull();
  });

  it("carries the house focus ring rather than the browser default", () => {
    stubOverflow({ scrollWidth: 900, clientWidth: 400 });
    const el = mount();
    expect(el.className).toContain("focus-visible:outline-brand");
  });

  it("keeps the caller's layout classes", () => {
    stubOverflow({ scrollWidth: 900, clientWidth: 400 });
    const el = mount({ className: "overflow-x-auto rounded-2xl" });
    expect(el.className).toContain("overflow-x-auto");
    expect(el.className).toContain("rounded-2xl");
  });
});
