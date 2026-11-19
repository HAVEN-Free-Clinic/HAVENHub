// @vitest-environment jsdom
/**
 * The DOM contract of a ranked DEPARTMENT_CHOICE and of a locked SINGLE_SELECT,
 * asserted against the posted FormData because that is what the server reads:
 * ranked slots must post in rank order under one name, and a locked choice must
 * still post its value (a disabled select would post nothing).
 */
import { afterEach, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FieldPreview, type PreviewFieldDef } from "./field-preview";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let mounted: { form: HTMLFormElement; root: Root } | null = null;

function mount(f: PreviewFieldDef, props: { prefill?: unknown; locked?: boolean } = {}): HTMLFormElement {
  const form = document.createElement("form");
  document.body.appendChild(form);
  const root = createRoot(form);
  act(() => {
    root.render(<FieldPreview f={f} departments={["SRHD", "SCTP", "MDIC"]} {...props} />);
  });
  mounted = { form, root };
  return form;
}

afterEach(() => {
  if (mounted) {
    act(() => mounted!.root.unmount());
    mounted.form.remove();
    mounted = null;
  }
});

const dept = (validation: Record<string, unknown> | null): PreviewFieldDef => ({
  key: "department_choice", label: "Department preference", helpText: null, type: "DEPARTMENT_CHOICE",
  required: true, options: null, validation,
});

it("renders a single department dropdown when rankCount is unset", () => {
  const form = mount(dept(null), { prefill: "SCTP" });
  expect(form.querySelectorAll("select")).toHaveLength(1);
  expect(new FormData(form).getAll("department_choice")).toEqual(["SCTP"]);
});

it("renders one labelled slot per ranked choice, 1st required, and posts them in order", () => {
  const form = mount(dept({ rankCount: 2 }), { prefill: ["SRHD", "MDIC"] });
  const selects = Array.from(form.querySelectorAll("select"));
  expect(selects).toHaveLength(2);
  expect(selects.map((s) => s.required)).toEqual([true, false]);
  expect(form.textContent).toContain("1st choice");
  expect(form.textContent).toContain("2nd choice");
  expect(new FormData(form).getAll("department_choice")).toEqual(["SRHD", "MDIC"]);
});

it("shows a locked choice read-only and still posts its value", () => {
  const f: PreviewFieldDef = {
    key: "prev_volunteered", label: "Have you previously volunteered at HAVEN?", helpText: "Filled in from your HAVEN record.",
    type: "SINGLE_SELECT", required: true,
    options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }],
    validation: { derive: "haven_volunteer_history" },
  };
  const form = mount(f, { prefill: "yes", locked: true });
  expect(form.querySelector("select")).toBeNull();
  const shown = form.querySelector<HTMLInputElement>("input[type=text]")!;
  expect(shown.value).toBe("Yes");
  expect(shown.readOnly).toBe(true);
  expect(new FormData(form).get("prev_volunteered")).toBe("yes");
  expect(form.textContent).toContain("Filled in from your HAVEN record.");
});
