// @vitest-environment jsdom
/**
 * The compose-form dirty guard, and the reset argument added for the recipient
 * panel.
 *
 * Both behaviours are pinned because the panel needs one of them and the two
 * older consumers (ReviewActions, TimingActions) depend on the other: they pass
 * no savedAt and are REMOUNTED by their parent to reset (#14), so if the hook
 * ever started resetting on its own it would clear their guard mid-edit and let
 * a stale audience be previewed, tested, or scheduled.
 *
 * Follows audience-builder.test.tsx: bare createRoot + act(), no
 * testing-library.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useFormDirty } from "./use-form-dirty";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let form: HTMLFormElement;

function Probe({ savedAt }: { savedAt?: string }) {
  const dirty = useFormDirty("a-form", savedAt);
  return <span data-testid="state">{dirty ? "dirty" : "clean"}</span>;
}

function mount(savedAt?: string) {
  form = document.createElement("form");
  form.id = "a-form";
  form.appendChild(document.createElement("input"));
  document.body.appendChild(form);

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Probe savedAt={savedAt} />));
}

function rerender(savedAt?: string) {
  act(() => root.render(<Probe savedAt={savedAt} />));
}

function edit() {
  act(() => {
    form.querySelector("input")!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const state = () => container.textContent;

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  form.remove();
});

describe("useFormDirty", () => {
  it("latches dirty and never clears it when no saved version is supplied", () => {
    mount();
    expect(state()).toBe("clean");

    edit();
    expect(state()).toBe("dirty");

    // A re-render with the same (absent) savedAt must not forgive the edit:
    // the older consumers rely on a REMOUNT being the only way back, and a
    // parent re-render happens on every soft nav.
    rerender();
    expect(state()).toBe("dirty");
  });

  it("clears dirty when a newer saved version arrives, and stays clear until the next edit", () => {
    mount("v1");
    edit();
    expect(state()).toBe("dirty");

    rerender("v2");
    expect(state()).toBe("clean");

    // Still watching: the listener survives the reset rather than being torn
    // down with it.
    edit();
    expect(state()).toBe("dirty");

    // And a re-render carrying the SAME saved version does not forgive it.
    rerender("v2");
    expect(state()).toBe("dirty");
  });
});
