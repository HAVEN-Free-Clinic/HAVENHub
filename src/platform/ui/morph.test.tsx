// @vitest-environment jsdom
/**
 * ViewSwap's focus handoff. After a swap the control a keyboard user was on has
 * left the DOM, so focus must land in the new view, but never on the first
 * render: a dialog opening on step 1 should keep its own focus placement.
 *
 * Bare createRoot + act(), like modal.test.tsx: this repo has no
 * @testing-library/react.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MorphHeight, ViewSwap } from "./morph";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(step: string, direction: 1 | -1 = 1) {
  if (!container) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  act(() =>
    root!.render(
      <MorphHeight>
        <ViewSwap viewKey={step} direction={direction}>
          <button type="button" data-testid={step}>
            {step}
          </button>
        </ViewSwap>
      </MorphHeight>,
    ),
  );
}

const byTestId = (id: string) => document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("ViewSwap", () => {
  it("leaves focus alone on the first view", () => {
    render("one");
    expect(byTestId("one")).not.toBeNull();
    expect(document.activeElement).toBe(document.body);
  });

  // No waiting between swaps on purpose: Back arrives while "one" is still
  // exiting, so it comes back without remounting. That is the case a
  // mount-based focus missed.
  it("moves focus into the new view after a swap, forward and back", () => {
    render("one");
    render("two", 1);
    expect(document.activeElement).toBe(byTestId("two"));
    render("one", -1);
    expect(document.activeElement).toBe(byTestId("one"));
  });
});
