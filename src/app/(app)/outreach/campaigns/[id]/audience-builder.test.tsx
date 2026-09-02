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
import type { Audience, ConditionOp } from "@/platform/email/audience/types";
import { AudienceBuilder, defaultConditionFor, getFieldOptions, opLabel } from "./audience-builder";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TERMS = [
  { id: "t-fa26", label: "FA26 (current)" },
  { id: "t-su26", label: "SU26 - Summer 2026" },
  { id: "t-sp26", label: "SP26 - Spring 2026" },
];
const CYCLES = [{ id: "c-fall", label: "Fall 2026 (open)" }];
const DEPARTMENTS = [{ code: "CARDIO", name: "Cardiology" }];
const SUBCOMMITTEES = [{ id: "sub-outreach", label: "Outreach" }];
const ZONE_LABEL = "Eastern (New York)";

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
        zoneLabel={ZONE_LABEL}
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

/** React installs its own value setter, so a plain assignment does not fire onChange. */
function typeInto(input: HTMLInputElement, text: string) {
  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    nativeSetter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function chooseOp(op: ConditionOp) {
  const select = container.querySelector('select[aria-label="Operator"]') as HTMLSelectElement;
  act(() => {
    select.value = op;
    select.dispatchEvent(new Event("change", { bubbles: true }));
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

// OP_LABELS used to be keyed by operator alone, so `lt`/`gt` read "is before"
// and "is after" for EVERY kind that declares them. DATE_OPERATORS contains
// neither (dates use before/after), so those two labels were consumed only by
// `year` and `count` fields, and a shift-count condition rendered as
// "Shifts assigned this term is before 3", which says something the condition
// does not mean.
describe("opLabel", () => {
  it("never describes a count comparison in chronological words", () => {
    const counts = PERSON_FIELD_VIEWS.filter((f) => f.kind === "count");
    // Guard the guard: with no count fields registered the loop below passes
    // vacuously and stops meaning anything.
    expect(counts.length).toBeGreaterThan(0);
    for (const field of counts) {
      for (const op of field.operators) {
        expect(opLabel(field.kind, op), `${field.key} / ${op}`).not.toMatch(/before|after/i);
      }
    }
  });

  it("labels an ordered count comparison numerically", () => {
    expect(opLabel("count", "lt")).toBe("is less than");
    expect(opLabel("count", "gt")).toBe("is greater than");
  });

  // A graduation year IS a point in time, so the chronological reading is the
  // right one there. This is the half of the fix that is easy to lose by
  // renaming the shared label instead of making resolution kind-aware.
  it("keeps the chronological reading for a year field", () => {
    expect(opLabel("year", "lt")).toBe("is before");
    expect(opLabel("year", "gt")).toBe("is after");
  });

  it("keeps the date operators' own wording", () => {
    expect(opLabel("date", "before")).toBe("is before");
    expect(opLabel("date", "after")).toBe("is after");
    expect(opLabel("date", "onOrBefore")).toBe("is on or before");
    expect(opLabel("date", "onOrAfter")).toBe("is on or after");
  });

  // The control now supplies the "days" unit next to the input, so the label
  // no longer has to carry it in parentheses.
  it("drops the parenthetical unit from the relative windows, which the control now shows", () => {
    expect(opLabel("date", "withinNextDays")).toBe("is within the next");
    expect(opLabel("date", "withinLastDays")).toBe("is within the last");
  });

  it("gives every operator every registered field declares a non-empty label", () => {
    for (const field of PERSON_FIELD_VIEWS) {
      for (const op of field.operators) {
        expect(opLabel(field.kind, op).length, `${field.key} (${field.kind}) / ${op}`)
          .toBeGreaterThan(0);
      }
    }
  });
});

// The mandated render check: a date field and a count field driven end to end
// through the real builder, asserting the JSON the save action would receive.
// tsc and eslint do not catch a control that renders but serialises the wrong
// shape, and the wrong shape compiles to match-nobody rather than throwing.
describe("AudienceBuilder date and count value controls", () => {
  it("renders a date input for a date field and serialises a bare YYYY-MM-DD", () => {
    render({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "joinedAt", op: "onOrAfter", value: "" }],
    });
    const dateInput = container.querySelector<HTMLInputElement>('input[aria-label="Date"]')!;
    expect(dateInput).toBeTruthy();
    expect(dateInput.type).toBe("date");

    typeInto(dateInput, "2026-03-20");
    expect(serialised().conditions[0]).toEqual({
      field: "joinedAt",
      op: "onOrAfter",
      value: "2026-03-20",
    });
  });

  it("stops rendering the generic text input for a date field", () => {
    render({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "joinedAt", op: "onOrAfter", value: "" }],
    });
    expect(container.querySelector('input[type="text"][aria-label="Value"]')).toBeNull();
  });

  it("names the clinic zone beside the date control", () => {
    render({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "joinedAt", op: "onOrAfter", value: "" }],
    });
    expect(container.textContent).toContain(ZONE_LABEL);
  });

  it("renders two date inputs for `between` and serialises a two-element array", () => {
    render({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "joinedAt", op: "between", value: ["", ""] }],
    });
    typeInto(container.querySelector<HTMLInputElement>('input[aria-label="Start date"]')!, "2026-03-18");
    typeInto(container.querySelector<HTMLInputElement>('input[aria-label="End date"]')!, "2026-03-20");
    expect(serialised().conditions[0]).toEqual({
      field: "joinedAt",
      op: "between",
      value: ["2026-03-18", "2026-03-20"],
    });
  });

  it("renders a whole-number input for a count field and serialises the number as a string", () => {
    render({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "shiftCountThisTerm", op: "gte", value: "" }],
    });
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Value"]')!;
    expect(input.type).toBe("number");
    expect(input.min).toBe("0");

    typeInto(input, "3");
    expect(serialised().conditions[0]).toEqual({
      field: "shiftCountThisTerm",
      op: "gte",
      value: "3",
    });
  });

  it("does not name the clinic zone for a count field", () => {
    render({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "shiftCountThisTerm", op: "gte", value: "" }],
    });
    expect(container.textContent).not.toContain(ZONE_LABEL);
  });

  it("labels a count condition's operator numerically, not chronologically", () => {
    render({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "shiftCountThisTerm", op: "lt", value: "3" }],
    });
    const select = container.querySelector('select[aria-label="Operator"]')!;
    expect(select.textContent).toContain("is less than");
    expect(select.textContent).not.toContain("is before");
  });

  it("keeps a negative day count out of the serialised audience", () => {
    render({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "joinedAt", op: "withinLastDays", value: "30" }],
    });
    typeInto(container.querySelector<HTMLInputElement>('input[aria-label="Days"]')!, "-5");
    expect(serialised().conditions[0]).toEqual({
      field: "joinedAt",
      op: "withinLastDays",
      value: "",
    });
    expect(container.textContent).toMatch(/whole number/i);
  });
});

// Operator changes that RESHAPE a value. A stale shape does not throw: it
// compiles to match-nobody, so the condition reads as configured and sends to
// no one. valueForOp is the single place that reshapes; these drive it through
// the rendered builder rather than calling it directly, so the control that
// then renders the value is covered too.
describe("AudienceBuilder operator changes that reshape a date or count value", () => {
  it("reduces a date `between` pair to a single day when switching to `before`", () => {
    render({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "joinedAt", op: "between", value: ["2026-03-18", "2026-03-20"] }],
    });
    chooseOp("before");
    expect(serialised().conditions[0]).toEqual({
      field: "joinedAt",
      op: "before",
      value: "2026-03-18",
    });
  });

  it("reduces a count `between` pair to a single value when switching to `gte`", () => {
    render({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "shiftCountThisTerm", op: "between", value: ["1", "3"] }],
    });
    chooseOp("gte");
    expect(serialised().conditions[0]).toEqual({
      field: "shiftCountThisTerm",
      op: "gte",
      value: "1",
    });
  });

  it("carries a single day into the start of a range when switching to `between`", () => {
    render({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "joinedAt", op: "before", value: "2026-03-18" }],
    });
    chooseOp("between");
    expect(serialised().conditions[0]).toEqual({
      field: "joinedAt",
      op: "between",
      value: ["2026-03-18", ""],
    });
  });

  it("clears the value when switching a date operator to isEmpty", () => {
    // hipaaCompletedAt, not joinedAt: joinedAt is Person.createdAt, which is NOT
    // NULL, so dateField drops isEmpty/isNotEmpty from its operator list.
    render({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "hipaaCompletedAt", op: "before", value: "2026-03-18" }],
    });
    chooseOp("isEmpty");
    expect(serialised().conditions[0]).toEqual({ field: "hipaaCompletedAt", op: "isEmpty" });
  });

  // A day COUNT is not a calendar day. Carrying "30" across would put it in a
  // date input, which renders blank while the stored audience still says "30".
  it("clears a relative window's day count when switching to an absolute date", () => {
    render({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "joinedAt", op: "withinLastDays", value: "30" }],
    });
    chooseOp("before");
    expect(serialised().conditions[0]).toEqual({ field: "joinedAt", op: "before", value: "" });
  });

  it("clears an absolute date when switching to a relative window", () => {
    render({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "joinedAt", op: "before", value: "2026-03-18" }],
    });
    chooseOp("withinNextDays");
    expect(serialised().conditions[0]).toEqual({
      field: "joinedAt",
      op: "withinNextDays",
      value: "",
    });
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
