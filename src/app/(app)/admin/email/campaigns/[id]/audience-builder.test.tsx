// @vitest-environment jsdom
/**
 * Interaction tests for the audience builder, focused on what it SERIALISES:
 * the hidden `audience` input is the entire contract with the save action, so a
 * control that looks right but writes the wrong JSON is invisible until a
 * campaign goes to the wrong people.
 *
 * Follows toast.test.tsx / combobox.test.tsx: bare createRoot + act(), no
 * testing-library.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PERSON_FIELD_VIEWS } from "@/platform/email/audience/person-fields";
import type { Audience } from "@/platform/email/audience/types";
import { AudienceBuilder } from "./audience-builder";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TERMS = [
  { id: "t-fa26", label: "FA26 (current)" },
  { id: "t-su26", label: "SU26 - Summer 2026" },
  { id: "t-sp26", label: "SP26 - Spring 2026" },
];
const CYCLES = [{ id: "c-fall", label: "Fall 2026 (open)" }];
const DEPARTMENTS = [{ code: "CARDIO", name: "Cardiology" }];

let container: HTMLDivElement;
let root: Root;

function render(initial: Audience) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <AudienceBuilder
        fields={PERSON_FIELD_VIEWS}
        departments={DEPARTMENTS}
        terms={TERMS}
        cycles={CYCLES}
        initial={initial}
      />,
    );
  });
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** The serialised audience the save action would receive. */
function serialised(): Audience {
  const input = container.querySelector<HTMLInputElement>('input[name="audience"]')!;
  return JSON.parse(input.value);
}

function click(el: Element | null | undefined) {
  act(() => {
    (el as HTMLElement).click();
  });
}

function labelled(text: string): HTMLInputElement | undefined {
  return [...container.querySelectorAll("label")]
    .find((l) => l.textContent?.includes(text))
    ?.querySelector("input") as HTMLInputElement | undefined;
}

const roleCondition: Audience = {
  recordType: "PERSON",
  match: "ALL",
  conditions: [{ field: "role", op: "eq", value: "VOLUNTEER" }],
};

describe("AudienceBuilder term scope", () => {
  beforeEach(() => render(roleCondition));

  it("shows the term picker for a roster field and records the picks", () => {
    click(labelled("SP26"));
    click(labelled("SU26"));
    expect(serialised().conditions[0]).toEqual({
      field: "role",
      op: "eq",
      value: "VOLUNTEER",
      terms: ["t-sp26", "t-su26"],
    });
  });

  it("omits the terms key entirely once the last term is unpicked", () => {
    // Not `terms: []`. An audience that never touched the picker must serialise
    // exactly as it did before term scoping existed, so old and new saves of the
    // same untouched condition are byte-identical.
    click(labelled("SP26"));
    expect(serialised().conditions[0]).toHaveProperty("terms");
    click(labelled("SP26"));
    expect(serialised().conditions[0]).not.toHaveProperty("terms");
  });

});

describe("AudienceBuilder non-roster fields", () => {
  it("does not show a term picker for a field that is not roster-shaped", () => {
    render({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "licensedRN", op: "isTrue" }],
    });
    expect(labelled("SP26")).toBeUndefined();
  });
});

describe("AudienceBuilder match modes", () => {
  it("never offers NONE at the root", () => {
    render(roleCondition);
    const rootToggle = container.querySelector("div.inline-flex")!;
    expect(rootToggle.textContent).toContain("ALL conditions");
    expect(rootToggle.textContent).toContain("ANY condition");
    expect(rootToggle.textContent).not.toContain("NONE");
  });

  it("offers NONE on a nested group", () => {
    render({
      recordType: "PERSON",
      match: "ALL",
      conditions: [
        { field: "role", op: "eq", value: "VOLUNTEER" },
        { match: "ALL", children: [{ field: "licensedRN", op: "isTrue" }] },
      ],
    });
    const toggles = container.querySelectorAll("div.inline-flex");
    expect(toggles[1].textContent).toContain("NONE of these");
  });

  it("switching a nested group to NONE serialises it", () => {
    render({
      recordType: "PERSON",
      match: "ALL",
      conditions: [
        { field: "role", op: "eq", value: "VOLUNTEER" },
        { match: "ALL", children: [{ field: "licensedRN", op: "isTrue" }] },
      ],
    });
    const noneButton = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "NONE of these",
    );
    click(noneButton);
    expect(serialised().conditions[1]).toEqual({
      match: "NONE",
      children: [{ field: "licensedRN", op: "isTrue" }],
    });
  });
});

describe("AudienceBuilder operator changes", () => {
  it("clears a typed value when switching to a checkbox operator, and back", () => {
    // The shapes are incompatible: a checkbox selection is string[], a typed
    // value is a bare string. Carrying one across produces a condition that
    // looks filled in but compiles to match-nobody.
    render({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "status", op: "eq", value: "ACTIVE" }],
    });
    const opSelect = container.querySelectorAll("select")[1] as HTMLSelectElement;

    act(() => {
      opSelect.value = "in";
      opSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(serialised().conditions[0]).toEqual({ field: "status", op: "in", value: [] });

    act(() => {
      opSelect.value = "notEq";
      opSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(serialised().conditions[0]).toEqual({ field: "status", op: "notEq", value: "" });
  });

  it("drops the value entirely for a valueless operator", () => {
    render({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "netId", op: "contains", value: "ab" }],
    });
    const opSelect = container.querySelectorAll("select")[1] as HTMLSelectElement;
    act(() => {
      opSelect.value = "isEmpty";
      opSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(serialised().conditions[0]).toEqual({ field: "netId", op: "isEmpty" });
  });
});
