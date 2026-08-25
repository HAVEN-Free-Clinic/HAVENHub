// @vitest-environment jsdom
/**
 * The DOM contract of a NOTICE field, which is the whole point of the type: it
 * must render authored content and, unless it asks to be acknowledged, put
 * NOTHING in the form. Asserted against the real DOM rather than the props,
 * because "contributes no answer" is a claim about the submitted FormData --
 * a stray hidden input or an empty-named control would silently reintroduce
 * the key that buildApplicationSchema was taught to drop.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FieldPreview, type PreviewFieldDef } from "./field-preview";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let mounted: { container: HTMLDivElement; root: Root } | null = null;

const notice = (o: Partial<PreviewFieldDef> = {}): PreviewFieldDef => ({
  key: "ai_use",
  label: "AI use",
  helpText: "AI assistance is not encouraged for this application.",
  type: "NOTICE",
  required: false,
  options: null,
  validation: null,
  ...o,
});

function mount(f: PreviewFieldDef): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<FieldPreview f={f} departments={[]} />);
  });
  mounted = { container, root };
  return container;
}

afterEach(() => {
  if (!mounted) return;
  const { container, root } = mounted;
  act(() => root.unmount());
  container.remove();
  mounted = null;
});

describe("FieldPreview NOTICE", () => {
  it("renders the heading and body and emits no form control", () => {
    const el = mount(notice());
    expect(el.textContent).toContain("AI use");
    expect(el.textContent).toContain("AI assistance is not encouraged");
    expect(el.querySelectorAll("input, select, textarea")).toHaveLength(0);
  });

  it("renders body-only when the heading is blank, which is the common case", () => {
    const el = mount(notice({ label: "" }));
    expect(el.textContent).toContain("AI assistance is not encouraged");
    expect(el.querySelectorAll("input, select, textarea")).toHaveLength(0);
  });

  it("is static content, not a live region a screen reader re-announces", () => {
    const el = mount(notice());
    expect(el.querySelector("[role='note']")).not.toBeNull();
    expect(el.querySelector("[role='status']")).toBeNull();
  });

  it("emits a checkbox under its own key once it asks to be acknowledged", () => {
    const el = mount(notice({ validation: { acknowledge: true, acknowledgeLabel: "I understand" }, required: true }));
    const box = el.querySelector<HTMLInputElement>("input[type='checkbox']");
    expect(box).not.toBeNull();
    expect(box!.name).toBe("ai_use");
    expect(box!.required).toBe(true);
    expect(el.textContent).toContain("I understand");
  });

  it("turns a URL in the body into a real link, since the stored text cannot hold markup", () => {
    const el = mount(notice({ helpText: "See havenfreeclinic.com/policies for details." }));
    const link = el.querySelector("a");
    expect(link).not.toBeNull();
    expect(link!.getAttribute("href")).toContain("havenfreeclinic.com/policies");
    // linkifyUrls appends a visually-hidden "(opens in a new tab)", hence contain.
    expect(link!.textContent).toContain("havenfreeclinic.com/policies");
    // The trailing sentence punctuation stays outside the link.
    expect(el.textContent).toContain("for details.");
  });
});
