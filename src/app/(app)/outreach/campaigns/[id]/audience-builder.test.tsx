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
import { AudienceBuilder, defaultConditionFor, getFieldOptions } from "./audience-builder";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TERMS = [
  { id: "t-fa26", label: "FA26 (current)" },
  { id: "t-su26", label: "SU26 - Summer 2026" },
  { id: "t-sp26", label: "SP26 - Spring 2026" },
];
const CYCLES = [{ id: "c-fall", label: "Fall 2026 (open)" }];
const DEPARTMENTS = [{ code: "CARDIO", name: "Cardiology" }];
const SUBCOMMITTEES = [{ id: "sub-outreach", label: "Outreach" }];

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
        subcommittees={SUBCOMMITTEES}
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
    // Selected by aria-label, not position: the field control (FieldPicker) is
    // no longer a native <select>, so it no longer occupies a select index.
    const opSelect = container.querySelector('select[aria-label="Operator"]') as HTMLSelectElement;

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
    // Selected by aria-label, not position: the field control (FieldPicker) is
    // no longer a native <select>, so it no longer occupies a select index.
    const opSelect = container.querySelector('select[aria-label="Operator"]') as HTMLSelectElement;
    act(() => {
      opSelect.value = "isEmpty";
      opSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(serialised().conditions[0]).toEqual({ field: "netId", op: "isEmpty" });
  });
});

// A default condition whose operator isn't declared by its own field reaches
// personFieldWhere's operator gate (person-fields.ts), which compiles it to
// MATCH_NOBODY -- safe under ALL/ANY, but a send-all under a NONE group. This
// is exactly the class of bug that made a freshly added date condition widen
// an audience to the whole Person table (see person-fields.test.ts and
// compile.test.ts for the compiled-where-clause side of the same guarantee).
describe("defaultConditionFor", () => {
  it("returns an operator every field's own registry actually declares, for every registered field", () => {
    for (const field of PERSON_FIELD_VIEWS) {
      const cond = defaultConditionFor(field);
      expect(field.operators, `field "${field.key}" (${field.kind})`).toContain(cond.op);
    }
  });
});

// #82-class bug for the two newest recruitment fields: a multiEnum field with
// no static `options` and no case in getFieldOptions renders "No options
// available" forever, so a value can never be picked (audience-builder.tsx).
describe("getFieldOptions", () => {
  const departments = [{ code: "CARDIO", name: "Cardiology" }];
  const cycles = [{ id: "c-fall", label: "Fall 2026 (open)" }];
  const subcommittees = [{ id: "sub-outreach", label: "Outreach" }];

  it("gives every dynamically-sourced multiEnum field a non-empty option source when data exists", () => {
    const dynamic = PERSON_FIELD_VIEWS.filter(
      (f) => f.kind === "multiEnum" && (f.options?.length ?? 0) === 0,
    );
    // Guard the guard: if this ever drops to zero, the test below passes
    // vacuously and stops meaning anything.
    expect(dynamic.length).toBeGreaterThan(0);
    for (const field of dynamic) {
      const options = getFieldOptions(field, departments, cycles, subcommittees);
      expect(options.length, `field "${field.key}" has no option source`).toBeGreaterThan(0);
    }
  });

  it("maps acceptedInCycle to the same cycle source as appliedToCycle", () => {
    const field = PERSON_FIELD_VIEWS.find((f) => f.key === "acceptedInCycle")!;
    expect(getFieldOptions(field, departments, cycles, subcommittees)).toEqual([
      { value: "c-fall", label: "Fall 2026 (open)" },
    ]);
  });

  it("maps subcommittee to the subcommittees source", () => {
    const field = PERSON_FIELD_VIEWS.find((f) => f.key === "subcommittee")!;
    expect(getFieldOptions(field, departments, cycles, subcommittees)).toEqual([
      { value: "sub-outreach", label: "Outreach" },
    ]);
  });
});

describe("AudienceBuilder recruitment option rendering", () => {
  it("renders subcommittee checkboxes instead of 'No options available'", () => {
    render({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "subcommittee", op: "in", value: [] }],
    });
    expect(container.textContent).toContain("Outreach");
    expect(container.textContent).not.toContain("No options available");
  });

  it("renders acceptedInCycle checkboxes instead of 'No options available'", () => {
    render({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "acceptedInCycle", op: "in", value: [] }],
    });
    expect(container.textContent).toContain("Fall 2026 (open)");
    expect(container.textContent).not.toContain("No options available");
  });
});

// Fix round 1 finding: FieldPicker's "remove unknown field" control used to
// call changeField("") -> `fields.find(...) ?? fields[0]`, which silently
// rewrote the condition to `{ field: "name", op: "contains", value: "" }`
// rather than removing it. That fails closed at compile time (MATCH_NOBODY),
// but reads to a sender reviewing an audience as a fully-configured,
// legitimate "Full name contains (empty)" condition -- not as the removed,
// unfinished row it actually is. This test exercises the fix through the
// whole stack: a stored condition naming a field key the registry no longer
// has, with the picker's own remove control activated.
describe("AudienceBuilder unknown stored field", () => {
  it("removes the whole condition rather than silently defaulting to a name condition", () => {
    render({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "aFieldThatNoLongerExists", op: "eq", value: "x" }],
    });
    expect(container.textContent).toContain("Unknown field");

    const removeButton = container.querySelector(
      'button[aria-label="Remove unknown field"]',
    ) as HTMLButtonElement;
    expect(removeButton).toBeTruthy();

    click(removeButton);

    expect(serialised().conditions).toEqual([]);
    expect(serialised().conditions).not.toContainEqual(
      expect.objectContaining({ field: "name" }),
    );
  });
});
