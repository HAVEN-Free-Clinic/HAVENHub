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
import { act } from "react";
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

  // Leaving the last accepted number in the stored audience while the box shows
  // something else is the "looks right, sends wrong" failure this whole file
  // exists to catch: clear it instead, so the condition is unambiguously
  // incomplete and the message explains why.
  it("clears the stored value rather than leaving the last accepted number behind", () => {
    const onChange = vi.fn();
    render("date", "withinNextDays", "30", onChange);
    type(inputs()[0], "-5");
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("accepts a valid number again after a rejected one", () => {
    const onChange = vi.fn();
    render("date", "withinNextDays", "", onChange);
    type(inputs()[0], "-5");
    type(inputs()[0], "7");
    expect(onChange).toHaveBeenLastCalledWith("7");
    expect(container.textContent).not.toMatch(/whole number/i);
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
    expect(onChange).not.toHaveBeenCalledWith("-1");
    expect(container.textContent).toMatch(/whole number|whole, non-negative/i);
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
