// @vitest-environment jsdom
/**
 * Interaction tests for Combobox's blur behavior (the only interactive path
 * in this file; everything else is covered by static-markup rendering
 * elsewhere in the repo). This is the one component test in the repo that
 * needs a real DOM, so it opts into the jsdom environment per-file rather
 * than switching the whole suite over from Node.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { Combobox } from "./combobox";

// jsdom doesn't implement layout, so scrollIntoView (used to keep the
// keyboard-highlighted option visible) is missing; stub it, same as jsdom
// consumers everywhere have to.
if (!window.HTMLElement.prototype.scrollIntoView) {
  window.HTMLElement.prototype.scrollIntoView = () => {};
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const options = [
  { value: "1", label: "Alex Rivera" },
  { value: "2", label: "Jamie Chen" },
];

let mounted: { container: HTMLDivElement; root: Root } | null = null;

function mount(el: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(el);
  });
  mounted = { container, root };
  return container;
}

function typeInto(input: HTMLInputElement, text: string) {
  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value"
  )!.set!;
  act(() => {
    nativeSetter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function blur(input: HTMLInputElement, relatedTarget: EventTarget | null) {
  act(() => {
    // React implements onBlur via the bubbling "focusout" event, not the
    // native non-bubbling "blur" (which its root-level delegation never
    // sees), so that's what has to be dispatched here.
    const evt = new FocusEvent("focusout", { bubbles: true });
    // jsdom's FocusEvent constructor does not accept relatedTarget in its
    // init dict on all versions; set it directly so the component's
    // rootRef.contains(e.relatedTarget) check sees it.
    Object.defineProperty(evt, "relatedTarget", { value: relatedTarget });
    input.dispatchEvent(evt);
  });
}

afterEach(() => {
  if (mounted) {
    act(() => {
      mounted!.root.unmount();
    });
    mounted.container.remove();
    mounted = null;
  }
});

describe("Combobox aria-required default", () => {
  it("omits aria-required entirely when required is not set (DOM byte-identical to before)", () => {
    const html = renderToStaticMarkup(<Combobox name="x" options={options} ariaLabel="x" />);
    expect(html).not.toContain("aria-required");
  });

  it('renders aria-required="true" when required is set', () => {
    const html = renderToStaticMarkup(
      <Combobox name="x" options={options} ariaLabel="x" required />
    );
    expect(html).toContain('aria-required="true"');
  });
});

describe("Combobox blur behavior", () => {
  it("clears typed text on blur when no option was selected, so native `required` blocks the submit", () => {
    const container = mount(
      <Combobox name="personId" options={options} ariaLabel="Person" required />
    );
    const input = container.querySelector("input[type=text]") as HTMLInputElement;
    const hidden = container.querySelector("input[type=hidden]") as HTMLInputElement;

    typeInto(input, "Alex Rivera");
    expect(input.value).toBe("Alex Rivera");
    expect(hidden.value).toBe("");

    // Blur to somewhere outside the whole combobox.
    blur(input, document.body);

    expect(input.value).toBe("");
    expect(hidden.value).toBe("");
  });

  it("does not clear the query when focus moves to another element inside the combobox (e.g. an option)", () => {
    const container = mount(<Combobox name="personId" options={options} ariaLabel="Person" />);
    const input = container.querySelector("input[type=text]") as HTMLInputElement;

    typeInto(input, "Alex");
    const optionEl = container.querySelector('li[role="option"]') as HTMLLIElement;
    expect(optionEl).toBeTruthy();

    // Focus moving to the option inside rootRef must not clear the query or
    // close the list -- otherwise the mousedown-driven selection below it
    // could never fire against a visible option.
    blur(input, optionEl);

    expect(input.value).toBe("Alex");
    expect(container.querySelector('ul[role="listbox"]')).not.toBeNull();
  });

  it("keeps the selected value and label text across a later blur", () => {
    const container = mount(<Combobox name="personId" options={options} ariaLabel="Person" />);
    const input = container.querySelector("input[type=text]") as HTMLInputElement;
    const hidden = container.querySelector("input[type=hidden]") as HTMLInputElement;

    typeInto(input, "Alex");
    const optionEl = container.querySelector('li[role="option"]') as HTMLLIElement;
    act(() => {
      optionEl.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    });

    expect(hidden.value).toBe("1");
    expect(input.value).toBe("Alex Rivera");

    blur(input, document.body);

    // A real selection survives the blur: the value stays picked and the
    // label stays in the box (only an abandoned, unselected query is cleared).
    expect(hidden.value).toBe("1");
    expect(input.value).toBe("Alex Rivera");
  });
});
