// @vitest-environment jsdom
/**
 * `indeterminate` is a DOM PROPERTY, not an attribute: it never appears in
 * markup, so static rendering cannot see it. These are the parts that only
 * exist in a live DOM.
 *
 * The mechanism is a callback ref rather than useRef + useEffect, because
 * checkbox.tsx carries no "use client" and a couple of dozen server components
 * render it -- a hook there would break every one of them.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Checkbox } from "./checkbox";

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

function box(c: HTMLElement) {
  return c.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
}

afterEach(() => {
  if (mounted) {
    const { container, root } = mounted;
    act(() => root.unmount());
    container.remove();
    mounted = null;
  }
});

describe("Checkbox indeterminate", () => {
  it("sets the property a select-all box needs for a partial selection", () => {
    // Two bulk-selection tables rendered `checked={allSelected}` alone, so some
    // rows selected reported "unchecked" to the accessibility tree while rows
    // were plainly ticked.
    const c = mount(<Checkbox aria-label="Select all" checked={false} indeterminate readOnly />);
    expect(box(c).indeterminate).toBe(true);
  });

  it("clears it when the selection completes", () => {
    const c = mount(<Checkbox aria-label="Select all" checked={false} indeterminate readOnly />);
    expect(box(c).indeterminate).toBe(true);
    act(() =>
      mounted!.root.render(
        <Checkbox aria-label="Select all" checked indeterminate={false} readOnly />,
      ),
    );
    // The property has to track the prop across renders. A callback ref is
    // re-created each render, which is what re-applies it.
    expect(box(c).indeterminate).toBe(false);
    expect(box(c).checked).toBe(true);
  });

  it("leaves it false when the prop is omitted, for the ~90 sites that never pass it", () => {
    const c = mount(<Checkbox aria-label="One" checked={false} readOnly />);
    expect(box(c).indeterminate).toBe(false);
  });

  it("still gives a caller its own ref", () => {
    // The primitive attaches its own callback ref now. Composing rather than
    // replacing is what stops it silently stealing a ref a call site depends
    // on -- onboarding-table held one for exactly this before moving to the prop.
    let seen: HTMLInputElement | null = null;
    mount(
      <Checkbox
        aria-label="One"
        checked={false}
        readOnly
        indeterminate
        ref={(el) => {
          if (el) seen = el;
        }}
      />,
    );
    expect(seen).not.toBeNull();
    expect(seen!.indeterminate).toBe(true);
  });
});
