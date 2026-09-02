// @vitest-environment jsdom
/**
 * Tests for the date / count / relative-window value controls.
 *
 * The contract these have to keep is not "does it look right", it is the exact
 * VALUE SHAPE each control emits: `dateBoundaryFor` and `countWhere` in
 * `@/platform/email/audience/operators.ts` parse a bare "YYYY-MM-DD" string, a
 * two-element array, or a whole-number string, and anything else compiles to
 * match-nobody. A control that renders beautifully and emits `["2026-03-20"]`
 * produces a campaign that silently goes to no one, so every assertion below is
 * on what reached `onChange`.
 *
 * Bare createRoot + act(), no testing-library: see audience-builder.test.tsx.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PersonFieldKind } from "@/platform/email/audience/person-fields";
import type { AudienceCondition, ConditionOp } from "@/platform/email/audience/types";
import { ValueControl } from "./value-controls";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ZONE_LABEL = "Eastern (New York)";

let container: HTMLDivElement;
let root: Root;

function render(
  kind: PersonFieldKind,
  op: ConditionOp,
  value: AudienceCondition["value"],
  onChange: (v: AudienceCondition["value"]) => void = () => {},
) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <ValueControl kind={kind} op={op} value={value} onChange={onChange} zoneLabel={ZONE_LABEL} />,
    );
  });
}

/**
 * Renders the control the way the builder really does: with the emitted value
 * fed straight back in as the next `value`. A `vi.fn()` onChange leaves the
 * prop frozen at its initial value, which is fine for asserting what was
 * emitted but useless for asserting what the control shows AFTERWARDS.
 */
function renderControlled(kind: PersonFieldKind, op: ConditionOp, initial: AudienceCondition["value"]) {
  function Harness() {
    const [value, setValue] = useState(initial);
    return (
      <ValueControl kind={kind} op={op} value={value} onChange={setValue} zoneLabel={ZONE_LABEL} />
    );
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Harness />));
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** React installs its own value setter, so a plain assignment does not fire onChange. */
function type(input: HTMLInputElement, text: string) {
  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    nativeSetter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function inputs(): HTMLInputElement[] {
  return [...container.querySelectorAll("input")];
}

function byLabel(label: string): HTMLInputElement {
  return container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
}

// ---------------------------------------------------------------------------
// Absolute dates
// ---------------------------------------------------------------------------

const SINGLE_DATE_OPS: ConditionOp[] = ["before", "after", "onOrBefore", "onOrAfter"];

describe("date, one absolute boundary", () => {
  it.each(SINGLE_DATE_OPS)("renders one date input for %s and emits a bare YYYY-MM-DD", (op) => {
    const onChange = vi.fn();
    render("date", op, "", onChange);

    expect(inputs()).toHaveLength(1);
    expect(inputs()[0].type).toBe("date");

    type(inputs()[0], "2026-03-20");
    expect(onChange).toHaveBeenCalledWith("2026-03-20");
  });

  it("shows the current value", () => {
    render("date", "before", "2026-03-20");
    expect(inputs()[0].value).toBe("2026-03-20");
  });

  // Fix round 1, finding 1. The empty box is the match-nobody state a sender
  // actually reaches (add a condition, or backspace a value), and it was the
  // one state these controls stayed silent about while warning on the two rare
  // ones. Inside a NONE group an always-false leaf excludes nobody, so the
  // group header's "everyone matching any condition here is excluded" becomes
  // false and the audience quietly widens to everyone.
  it("says an empty date matches nobody", () => {
    render("date", "before", "");
    expect(container.textContent).toContain("matches nobody");
  });

  it("stops saying so once a date is chosen", () => {
    render("date", "before", "2026-03-20");
    expect(container.textContent).not.toContain("matches nobody");
  });

  // Part A resolves a calendar day in the CLINIC's configured zone, not the
  // sender's. Without this line a director in California picking "March 20"
  // has no way to know which March 20 they picked.
  it.each(SINGLE_DATE_OPS)("names the zone the date is read in, for %s", (op) => {
    render("date", op, "");
    expect(container.textContent).toContain(ZONE_LABEL);
  });

  // An <input type="date"> cannot emit an impossible date, but a stored
  // audience can carry one, and Part A's round-trip check now compiles it to
  // match-nobody. Without a message the sender sees an empty box and no reason.
  it("flags a stored date that is not a real calendar date", () => {
    render("date", "before", "2026-02-30");
    expect(container.textContent).toContain("not a real date");
  });

  it("does not flag a real date", () => {
    render("date", "before", "2026-03-20");
    expect(container.textContent).not.toContain("not a real date");
  });

  // startOfDay and startOfNextDay both `.trim()` before validating, so a stored
  // " 2026-03-20" compiles to a real boundary and matches people. Flagging it
  // here would have the row declare it matches nobody while it actually sends.
  it("does not flag a real date carrying stored whitespace", () => {
    render("date", "before", " 2026-03-20 ");
    expect(container.textContent).not.toContain("not a real date");
  });

  it("wires the notes to the input and marks it invalid", () => {
    render("date", "before", "2026-02-30");
    const input = byLabel("Date");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const describedBy = input.getAttribute("aria-describedby") ?? "";
    expect(describedBy).not.toBe("");
    for (const id of describedBy.split(" ")) {
      expect(document.getElementById(id), `no element with id ${id}`).toBeTruthy();
    }
  });

  it("does not mark a valid date invalid", () => {
    render("date", "before", "2026-03-20");
    expect(byLabel("Date").getAttribute("aria-invalid")).toBeNull();
  });
});

describe("date, between", () => {
  it("renders two date inputs and emits a two-element array", () => {
    const onChange = vi.fn();
    render("date", "between", ["", ""], onChange);

    const dateInputs = inputs();
    expect(dateInputs).toHaveLength(2);
    expect(dateInputs.every((i) => i.type === "date")).toBe(true);

    type(dateInputs[0], "2026-03-18");
    expect(onChange).toHaveBeenCalledWith(["2026-03-18", ""]);
  });

  it("keeps the other endpoint when one endpoint changes", () => {
    const onChange = vi.fn();
    render("date", "between", ["2026-03-18", "2026-03-20"], onChange);
    type(inputs()[1], "2026-03-25");
    expect(onChange).toHaveBeenCalledWith(["2026-03-18", "2026-03-25"]);
  });

  it("names the zone", () => {
    render("date", "between", ["", ""]);
    expect(container.textContent).toContain(ZONE_LABEL);
  });

  // The builder can now produce a reversed range with two clicks. Part A's
  // compiler answers with the match-nobody sentinel (see the `between` branch
  // in operators.ts), which is safe but invisible; say so at the control.
  it("warns when the range ends before it starts", () => {
    render("date", "between", ["2026-03-20", "2026-03-18"]);
    expect(container.textContent).toContain("matches nobody");
  });

  it("does not warn on a single-day range, which is valid", () => {
    render("date", "between", ["2026-03-18", "2026-03-18"]);
    expect(container.textContent).not.toContain("matches nobody");
  });

  // Finding 1 again: a half-filled range is the state you are in for as long as
  // it takes to pick the second date, and it compiles to match-nobody the whole
  // time (asArray drops the blank, so pair.length !== 2).
  it.each([
    ["neither endpoint", ["", ""]],
    ["only the start", ["2026-03-18", ""]],
    ["only the end", ["", "2026-03-20"]],
  ])("says a range with %s matches nobody", (_label, value) => {
    render("date", "between", value as string[]);
    expect(container.textContent).toContain("matches nobody");
  });

  // A Part A audience can hold a bare string under `between`: the old
  // valueForOp treated `between` as single-valued, so switching `before` ->
  // `between` left "2026-03-18" in place. Rendering two blank boxes over it
  // would hide a stored value that then re-serialises unchanged.
  it("shows a stored bare string in the start box and normalises it to a pair", () => {
    const onChange = vi.fn();
    render("date", "between", "2026-03-18", onChange);
    expect(byLabel("Start date").value).toBe("2026-03-18");
    expect(byLabel("End date").value).toBe("");
    expect(onChange).toHaveBeenCalledWith(["2026-03-18", ""]);
  });

  it("does not rewrite a value that is already a pair", () => {
    const onChange = vi.fn();
    render("date", "between", ["2026-03-18", "2026-03-20"], onChange);
    expect(onChange).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Relative windows
// ---------------------------------------------------------------------------

const WINDOW_OPS: ConditionOp[] = ["withinNextDays", "withinLastDays"];

describe("date, relative window", () => {
  it.each(WINDOW_OPS)("renders a number input with a days suffix for %s", (op) => {
    const onChange = vi.fn();
    render("date", op, "", onChange);

    expect(inputs()).toHaveLength(1);
    expect(inputs()[0].type).toBe("number");
    expect(container.textContent).toContain("days");

    type(inputs()[0], "30");
    expect(onChange).toHaveBeenCalledWith("30");
  });

  // A window is anchored on `now` at resolve time, so no calendar day is being
  // chosen and the clinic zone note would be noise.
  it.each(WINDOW_OPS)("does not name the zone for %s", (op) => {
    render("date", op, "");
    expect(container.textContent).not.toContain(ZONE_LABEL);
  });

  // Part A compiles a negative or fractional window to match-nobody: safe, but
  // the campaign silently goes to no one. The control has to say so, and must
  // not hand the compiler a value it will reject.
  it.each([
    ["a negative window", "-5"],
    ["a fractional window", "1.5"],
  ])("rejects %s at the control without emitting it", (_label, bad) => {
    const onChange = vi.fn();
    render("date", "withinNextDays", "", onChange);

    type(inputs()[0], bad);

    expect(onChange).not.toHaveBeenCalledWith(bad);
    expect(container.textContent).toMatch(/whole number|whole, non-negative/i);
  });

  it("keeps the rejected text visible so the sender can see what was typed", () => {
    render("date", "withinNextDays", "", () => {});
    type(inputs()[0], "-5");
    expect(inputs()[0].value).toBe("-5");
  });

  // Fix round 1, finding 2. A rejected entry must not reach onChange AT ALL, so
  // the previously stored number survives. "" and "-5" compile identically
  // (match-nobody), so overwriting 30 with "" bought nothing at compile time
  // and destroyed the author's work; and under a NONE group the empty state is
  // the maximally INCLUSIVE one, so clearing was the widening direction.
  it("leaves the stored value untouched when the entry is rejected", () => {
    const onChange = vi.fn();
    render("date", "withinNextDays", "30", onChange);
    type(inputs()[0], "-5");
    expect(onChange).not.toHaveBeenCalled();
  });

  // The box then shows something different from what is stored, which is only
  // honest if the control says which one is live.
  it("says the entry was not applied and names the value still in force", () => {
    render("date", "withinNextDays", "30", () => {});
    type(inputs()[0], "-5");
    expect(container.textContent).toMatch(/not applied/i);
    expect(container.textContent).toContain("30");
  });

  it("says the condition still matches nobody when the rejected entry sits over an empty value", () => {
    render("date", "withinNextDays", "", () => {});
    type(inputs()[0], "-5");
    expect(container.textContent).toMatch(/not applied/i);
    expect(container.textContent).toContain("matches nobody");
  });

  // Clearing the box is NOT a rejected entry: it is a deliberate empty state,
  // and it has to reach the audience or the stored number would be unremovable.
  it("propagates an emptied box", () => {
    const onChange = vi.fn();
    render("date", "withinNextDays", "30", onChange);
    type(inputs()[0], "");
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("says an empty window matches nobody", () => {
    render("date", "withinNextDays", "");
    expect(container.textContent).toContain("matches nobody");
  });

  it("accepts a valid number again after a rejected one", () => {
    const onChange = vi.fn();
    render("date", "withinNextDays", "", onChange);
    type(inputs()[0], "-5");
    type(inputs()[0], "7");
    expect(onChange).toHaveBeenLastCalledWith("7");
  });

  // Same journey, but with the value fed back so the notes reflect what is
  // actually stored at the end of it.
  it("drops both notes once the rejected entry is replaced by a valid one", () => {
    renderControlled("date", "withinNextDays", "");
    expect(container.textContent).toContain("matches nobody");
    type(inputs()[0], "-5");
    expect(container.textContent).toMatch(/not applied/i);
    type(inputs()[0], "7");
    expect(container.textContent).not.toMatch(/not applied/i);
    expect(container.textContent).not.toContain("matches nobody");
    expect(inputs()[0].value).toBe("7");
  });

  // The rejected entry really is durable against a re-render: the parent is
  // never told, so nothing arrives to overwrite the text on screen.
  it("keeps showing the rejected text while the stored value stays 30", () => {
    renderControlled("date", "withinNextDays", "30");
    type(inputs()[0], "-5");
    expect(inputs()[0].value).toBe("-5");
    expect(container.textContent).toContain("30");
  });

  it("wires the rejection note to the input and marks it invalid", () => {
    render("date", "withinNextDays", "30", () => {});
    type(inputs()[0], "-5");
    const input = byLabel("Days");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const describedBy = input.getAttribute("aria-describedby") ?? "";
    expect(describedBy).not.toBe("");
    for (const id of describedBy.split(" ")) {
      expect(document.getElementById(id), `no element with id ${id}`).toBeTruthy();
    }
  });
});

describe("date, valueless operators", () => {
  it.each<ConditionOp>(["isEmpty", "isNotEmpty"])("renders no control for %s", (op) => {
    render("date", op, undefined);
    expect(inputs()).toHaveLength(0);
    expect(container.textContent).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Counts
// ---------------------------------------------------------------------------

const COUNT_SINGLE_OPS: ConditionOp[] = ["eq", "notEq", "lt", "lte", "gt", "gte"];

describe("count, one comparison value", () => {
  it.each(COUNT_SINGLE_OPS)("renders one whole-number input for %s and emits a string", (op) => {
    const onChange = vi.fn();
    render("count", op, "", onChange);

    expect(inputs()).toHaveLength(1);
    const input = inputs()[0];
    expect(input.type).toBe("number");
    expect(input.min).toBe("0");
    expect(input.step).toBe("1");

    type(input, "3");
    expect(onChange).toHaveBeenCalledWith("3");
  });

  it("never names the clinic zone: a count is not a date", () => {
    render("count", "gte", "3");
    expect(container.textContent).not.toContain(ZONE_LABEL);
  });

  it("rejects a negative count without emitting it", () => {
    const onChange = vi.fn();
    render("count", "gte", "", onChange);
    type(inputs()[0], "-1");
    expect(onChange).not.toHaveBeenCalled();
    expect(container.textContent).toMatch(/whole number|whole, non-negative/i);
  });

  it("says an empty count matches nobody", () => {
    render("count", "gte", "");
    expect(container.textContent).toContain("matches nobody");
  });

  it("stops saying so once a number is entered", () => {
    render("count", "gte", "3");
    expect(container.textContent).not.toContain("matches nobody");
  });
});

describe("count, between", () => {
  it("renders two whole-number inputs and emits a two-element array", () => {
    const onChange = vi.fn();
    render("count", "between", ["", ""], onChange);

    const numberInputs = inputs();
    expect(numberInputs).toHaveLength(2);
    expect(numberInputs.every((i) => i.type === "number" && i.min === "0" && i.step === "1")).toBe(
      true,
    );

    type(numberInputs[0], "1");
    expect(onChange).toHaveBeenCalledWith(["1", ""]);
  });

  it("keeps the other endpoint when one endpoint changes", () => {
    const onChange = vi.fn();
    render("count", "between", ["1", "3"], onChange);
    type(byLabel("Highest value"), "9");
    expect(onChange).toHaveBeenCalledWith(["1", "9"]);
  });

  it.each([
    ["neither bound", ["", ""]],
    ["only the low bound", ["1", ""]],
    ["only the high bound", ["", "3"]],
  ])("says a range with %s matches nobody", (_label, value) => {
    render("count", "between", value as string[]);
    expect(container.textContent).toContain("matches nobody");
  });

  it("stops saying so once both bounds are entered", () => {
    render("count", "between", ["1", "3"]);
    expect(container.textContent).not.toContain("matches nobody");
  });
});

// ---------------------------------------------------------------------------
// Fix round 1, finding 3: constraint validation
// ---------------------------------------------------------------------------

// None of these inputs carries a `name`, so none of them contributes anything
// to a form submission: the builder submits exactly one field, the serialised
// JSON hidden input. Leaving them as form-owned controls let a rangeUnderflow
// or a half-typed date block Save from inside a `hidden` tab panel, where the
// browser cannot focus the offending control and gives up silently. See
// audience-builder.test.tsx for the form-level regression test.
describe("form participation", () => {
  it.each<[PersonFieldKind, ConditionOp, AudienceCondition["value"]]>([
    ["date", "before", ""],
    ["date", "between", ["", ""]],
    ["date", "withinNextDays", ""],
    ["count", "gte", ""],
    ["count", "between", ["", ""]],
  ])("detaches every input it renders for %s / %s from any form", (kind, op, value) => {
    const form = document.createElement("form");
    document.body.appendChild(form);
    container = document.createElement("div");
    form.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        <ValueControl kind={kind} op={op} value={value} onChange={() => {}} zoneLabel={ZONE_LABEL} />,
      );
    });

    const rendered = [...container.querySelectorAll("input")];
    expect(rendered.length).toBeGreaterThan(0);
    for (const input of rendered) {
      expect(input.form, `${input.getAttribute("aria-label")} still has a form owner`).toBeNull();
    }
    expect([...form.elements]).toHaveLength(0);

    form.remove();
  });
});

// ---------------------------------------------------------------------------
// Kinds this control deliberately does not own
// ---------------------------------------------------------------------------

// ConditionRow still renders its own checkbox / select / text controls for
// these. Returning a control here as well would render two value inputs for
// the same condition, only one of which is wired to onChange.
describe("kinds handled elsewhere", () => {
  it.each<PersonFieldKind>(["text", "enum", "multiEnum", "boolean", "year"])(
    "renders nothing for %s",
    (kind) => {
      render(kind, "eq", "x");
      expect(inputs()).toHaveLength(0);
      expect(container.textContent).toBe("");
    },
  );
});
