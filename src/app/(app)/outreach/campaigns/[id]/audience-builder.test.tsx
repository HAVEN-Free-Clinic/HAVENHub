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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PERSON_FIELD_VIEWS } from "@/platform/email/audience/person-fields";
import type { Audience, ConditionOp } from "@/platform/email/audience/types";
import { AudienceBuilder, defaultConditionFor, getFieldOptions, opLabel } from "./audience-builder";
import { NODE_COUNT_DEBOUNCE_MS } from "./use-node-counts";
import { MAX_COUNTED_NODES } from "./node-paths";

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

function render(
  initial: Audience,
  countAction?: (audience: Audience) => Promise<Record<string, number>>,
) {
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
        countAction={countAction}
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

/**
 * The first condition row's own subtree.
 *
 * Assertions about what a CONTROL says must not be made against the whole
 * container: the builder's header paragraph already contains the phrase
 * "matches nobody", so a container-wide check would pass with every note
 * deleted.
 */
function conditionRow(): HTMLElement {
  return container.querySelector<HTMLElement>("div.bg-muted")!;
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

  // Fix round 1, finding 2: a rejected entry leaves the stored value alone. It
  // does NOT clear it: "" and "-5" compile identically (match-nobody), so
  // clearing bought nothing while destroying the author's 30, and under a NONE
  // group the empty state is the maximally inclusive one. A stale-but-valid 30
  // is the narrow direction.
  it("keeps a negative day count out of the serialised audience without discarding the stored one", () => {
    render({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "joinedAt", op: "withinLastDays", value: "30" }],
    });
    typeInto(container.querySelector<HTMLInputElement>('input[aria-label="Days"]')!, "-5");
    expect(serialised().conditions[0]).toEqual({
      field: "joinedAt",
      op: "withinLastDays",
      value: "30",
    });
    expect(container.textContent).toMatch(/not applied/i);
  });

  // Fix round 1, finding 1: the empty box is the match-nobody state a sender
  // actually reaches, and it was the only one of the four the controls stayed
  // silent about.
  //
  // Asserted on the CONDITION ROW, not on the whole container: the builder's
  // own header paragraph says "an empty audience matches nobody", so a
  // container-wide assertion passes whether the control warns or not. Verified
  // by deleting the notes and watching the container-wide version keep passing.
  it.each([
    ["a date with no day chosen", { field: "joinedAt", op: "onOrAfter" as const, value: "" }],
    ["a half-filled range", { field: "joinedAt", op: "between" as const, value: ["2026-03-18", ""] }],
    ["an empty window", { field: "joinedAt", op: "withinLastDays" as const, value: "" }],
    ["an empty count", { field: "shiftCountThisTerm", op: "gte" as const, value: "" }],
  ])("says %s matches nobody", (_label, condition) => {
    render({ recordType: "PERSON", match: "ALL", conditions: [condition] });
    expect(conditionRow().textContent).toContain("matches nobody");
  });

  it("says nothing of the sort once the condition is complete", () => {
    render({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "joinedAt", op: "onOrAfter", value: "2026-03-20" }],
    });
    expect(conditionRow().textContent).not.toContain("matches nobody");
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

// ---------------------------------------------------------------------------
// Fix round 1, finding 3: the builder must never be able to block Save
// ---------------------------------------------------------------------------

/**
 * The campaign editor's shape, reproduced closely enough to exercise the bug:
 * one form, three panels that all stay MOUNTED and are toggled with the
 * `hidden` attribute (see page.tsx's comment on why they stay mounted), the
 * required campaign-name input in the Compose panel, and the audience builder
 * in the Audience panel.
 *
 * `display: none` does not bar an element from constraint validation, so before
 * the fix a "-5" left in a Days box made the whole form invalid. The browser
 * cannot focus a hidden control, so it logged "An invalid form control with
 * name='' is not focusable" and ABORTED the submit with nothing on screen: the
 * sender clicks Save and believes the campaign saved. jsdom does not really
 * implement form submission, so the invariant is asserted at the DOM level
 * instead: nothing the audience builder renders may make the compose form
 * invalid.
 */
function EditorHarness({ initial }: { initial: Audience }) {
  const [tab, setTab] = useState<"compose" | "audience">("audience");
  return (
    <div>
      <button type="button" data-tab="compose" onClick={() => setTab("compose")}>
        Compose tab
      </button>
      <button type="button" data-tab="audience" onClick={() => setTab("audience")}>
        Audience tab
      </button>
      <form id="campaign-compose">
        <div hidden={tab !== "compose"}>
          <input aria-label="Campaign name" name="name" type="text" defaultValue="Spring blast" required />
        </div>
        <div hidden={tab !== "audience"}>
          <AudienceBuilder
            fields={PERSON_FIELD_VIEWS}
            departments={DEPARTMENTS}
            terms={TERMS}
            cycles={CYCLES}
            subcommittees={SUBCOMMITTEES}
            initial={initial}
            zoneLabel={ZONE_LABEL}
          />
        </div>
        <button type="submit">Save</button>
      </form>
    </div>
  );
}

function renderEditor(initial: Audience) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<EditorHarness initial={initial} />));
}

function composeForm(): HTMLFormElement {
  return container.querySelector<HTMLFormElement>("#campaign-compose")!;
}

function switchTab(to: "compose" | "audience") {
  click(container.querySelector(`button[data-tab="${to}"]`));
}

describe("the audience builder inside the campaign editor's form", () => {
  it("cannot invalidate the compose form with an out-of-range day count", () => {
    renderEditor({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "joinedAt", op: "withinLastDays", value: "30" }],
    });
    typeInto(container.querySelector<HTMLInputElement>('input[aria-label="Days"]')!, "-5");

    // The tab switch is the whole point: this is where the control becomes
    // unfocusable and the browser gives up silently.
    switchTab("compose");
    expect(composeForm().checkValidity()).toBe(true);
  });

  it("cannot invalidate it with an out-of-range count either", () => {
    renderEditor({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "shiftCountThisTerm", op: "gte", value: "2" }],
    });
    typeInto(container.querySelector<HTMLInputElement>('input[aria-label="Value"]')!, "-1");
    switchTab("compose");
    expect(composeForm().checkValidity()).toBe(true);
  });

  // The mechanism, asserted directly so a regression names its own cause: these
  // controls carry no `name` and contribute nothing to the submission, so they
  // are detached from the form owner entirely and never appear in form.elements.
  it("puts none of its date or number inputs into form.elements", () => {
    renderEditor({
      recordType: "PERSON",
      match: "ALL",
      conditions: [
        { field: "joinedAt", op: "between", value: ["2026-03-18", "2026-03-20"] },
        { field: "shiftCountThisTerm", op: "between", value: ["1", "3"] },
      ],
    });
    // Four date/number controls are on screen (two range endpoints each).
    expect(
      container.querySelectorAll('input[type="date"], input[type="number"]'),
    ).toHaveLength(4);
    // None of them belongs to the form.
    const owned = [...composeForm().elements].filter(
      (el) => el instanceof HTMLInputElement && (el.type === "date" || el.type === "number"),
    );
    expect(owned).toHaveLength(0);
    // The only things that actually submit are the campaign name and the
    // builder's one serialised-audience hidden input.
    const named = [...composeForm().elements]
      .map((el) => el.getAttribute("name"))
      .filter((n): n is string => n !== null);
    expect(named.sort()).toEqual(["audience", "name"]);
  });

  // The audience still has to SUBMIT, and it does, through the one hidden input
  // the builder renders. Detaching the visible controls must not detach that.
  it("still submits the serialised audience", () => {
    renderEditor({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "joinedAt", op: "onOrAfter", value: "2026-03-20" }],
    });
    const data = new FormData(composeForm());
    expect(JSON.parse(String(data.get("audience"))).conditions[0]).toEqual({
      field: "joinedAt",
      op: "onOrAfter",
      value: "2026-03-20",
    });
  });

  // useFormDirty listens for bubbling input/change events ON THE FORM ELEMENT.
  // Detaching form OWNERSHIP leaves the controls as DOM descendants, so they
  // still bubble; moving the panel out of the form's subtree instead would have
  // silently stopped every audience edit from marking the draft dirty, and
  // ReviewActions would re-enable Send on an unsaved audience.
  it("still bubbles edits to the form element, so the unsaved-changes guard sees them", () => {
    renderEditor({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "joinedAt", op: "onOrAfter", value: "" }],
    });
    let heard = 0;
    composeForm().addEventListener("input", () => {
      heard += 1;
    });
    typeInto(container.querySelector<HTMLInputElement>('input[aria-label="Date"]')!, "2026-03-20");
    expect(heard).toBeGreaterThan(0);
  });

  // The pre-existing guard the fix must not weaken: the campaign name is the
  // one real constraint on this form, and it still blocks an empty submit.
  it("leaves the campaign name's required guard intact", () => {
    renderEditor({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "joinedAt", op: "onOrAfter", value: "2026-03-20" }],
    });
    expect(composeForm().checkValidity()).toBe(true);
    typeInto(container.querySelector<HTMLInputElement>('input[aria-label="Campaign name"]')!, "");
    expect(composeForm().checkValidity()).toBe(false);
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

// ---------------------------------------------------------------------------
// Per-node match counts
//
// The counts arrive as ONE map keyed by node path, so the thing that can go
// wrong on the client is the mapping: a row showing the count of a different
// clause is worse than showing none, because the sender would trust it. Each
// count is therefore tagged with the path it was drawn under, and these check
// the tag against the number.
// ---------------------------------------------------------------------------
describe("AudienceBuilder node counts", () => {
  const NESTED: Audience = {
    recordType: "PERSON",
    match: "ALL",
    conditions: [
      { field: "name", op: "contains", value: "a" },
      {
        match: "ANY",
        children: [
          { field: "name", op: "contains", value: "b" },
          { field: "name", op: "contains", value: "c" },
        ],
      },
    ],
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Every rendered count, keyed by the node path it was rendered under. */
  function countsShown(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const el of container.querySelectorAll<HTMLElement>("[data-node-count]")) {
      out[el.getAttribute("data-node-count")!] = el.textContent ?? "";
    }
    return out;
  }

  async function flush() {
    await act(async () => {
      vi.advanceTimersByTime(NODE_COUNT_DEBOUNCE_MS);
    });
  }

  it("puts each count on the node its path names", async () => {
    render(NESTED, async () => ({ root: 2, "0": 3, "1": 30, "1.0": 20, "1.1": 10 }));
    await flush();

    // Distinct numbers per node: a map read under the wrong key would have to
    // land right five times over.
    expect(countsShown()).toEqual({
      root: "Matches 2 people",
      "0": "Matches 3 people",
      "1": "Matches 30 people",
      "1.0": "Matches 20 people",
      "1.1": "Matches 10 people",
    });
  });

  it("sends the edited tree, not the tree it was first given", async () => {
    const seen: Audience[] = [];
    render(NESTED, async (audience) => {
      seen.push(audience);
      return {};
    });
    await flush();

    const value = container.querySelector<HTMLInputElement>('input[aria-label="Value"]')!;
    typeInto(value, "zzz");
    await flush();

    expect(seen[seen.length - 1].conditions[0]).toEqual({
      field: "name",
      op: "contains",
      value: "zzz",
    });
  });

  // A NONE group's count is what its OWN fragment matches (everyone matching
  // none of its children), which is routinely LARGER than the audience it sits
  // in. Left as a bare number it reads as "this group is adding 30 people",
  // when the group is a filter. The label is what closes that gap, so it is
  // asserted rather than left to review.
  it("labels a NONE group's count so it cannot be read as an addition", async () => {
    render(
      {
        recordType: "PERSON",
        match: "ALL",
        conditions: [
          { field: "name", op: "contains", value: "a" },
          { match: "NONE", children: [{ field: "name", op: "contains", value: "b" }] },
        ],
      },
      async () => ({ root: 2, "0": 3, "1": 30, "1.0": 10 }),
    );
    await flush();

    expect(countsShown()["1"]).toBe("Matches 30 people (everyone matching none of these)");
    // The plain groups keep the plain wording.
    expect(countsShown().root).toBe("Matches 2 people");
  });

  // The root's count label and the serialised audience must not be able to
  // disagree about the root connective. MatchToggle never offers NONE at depth
  // 0 and Audience.match excludes it, so this is unreachable through the UI --
  // but the two lines derived it separately, and only one of them narrowed.
  it("labels the root count with the same connective it serialises", async () => {
    render(
      { recordType: "PERSON", match: "NONE" as Audience["match"], conditions: [
        { field: "name", op: "contains", value: "a" },
      ] },
      async () => ({ root: 4, "0": 4 }),
    );
    await flush();

    expect(serialised().match).toBe("ALL");
    expect(countsShown().root).toBe("Matches 4 people");
    expect(countsShown().root).not.toContain("everyone matching none of these");
  });

  it("says person, not people, for a single match", async () => {
    render(NESTED, async () => ({ root: 1, "0": 1, "1": 0, "1.0": 0, "1.1": 0 }));
    await flush();
    expect(countsShown().root).toBe("Matches 1 person");
    expect(countsShown()["1"]).toBe("Matches 0 people");
  });

  it("renders no counts at all without a count action, as the scope editor does", async () => {
    render(NESTED);
    await flush();
    expect(countsShown()).toEqual({});
  });

  // The NONE parenthetical is the whole device that stops a widening group
  // being misread, so it must never appear beside a number compiled under a
  // different connective. Flipping the toggle changes the label instantly; the
  // count it would have labelled has to go at the same moment.
  it("drops a group's count the instant its connective flips, label and all", async () => {
    render(
      {
        recordType: "PERSON",
        match: "ALL",
        conditions: [
          { match: "ALL", children: [{ field: "name", op: "contains", value: "a" }] },
        ],
      },
      async () => ({ root: 5, "0": 5, "0.0": 5 }),
    );
    await flush();
    expect(countsShown()["0"]).toBe("Matches 5 people");

    // NONE is offered on nested groups only, so this is unambiguously the
    // nested group's toggle.
    click([...container.querySelectorAll("button")].find((b) => b.textContent === "NONE of these"));
    expect(countsShown()).toEqual({});
    expect(container.textContent).not.toContain("everyone matching none of these");
  });

  it("drops the map when a clause is removed and later siblings shift down", async () => {
    render(
      {
        recordType: "PERSON",
        match: "ALL",
        conditions: [
          { field: "name", op: "contains", value: "a" },
          { field: "name", op: "contains", value: "b" },
        ],
      },
      async () => ({ root: 5, "0": 7, "1": 9 }),
    );
    await flush();
    expect(countsShown()["0"]).toBe("Matches 7 people");

    // Remove the first row: what was "1" becomes "0", so a retained map would
    // print the removed clause's 7 against the survivor.
    click([...container.querySelectorAll("button")].find((b) => b.textContent === "Remove"));
    expect(countsShown()).toEqual({});
  });

  // A faded token is the obvious way to show "in flight" and the one that fails
  // WCAG AA here, so the in-flight cue is pinned as non-colour.
  it("marks an in-flight count without fading it below the readable token", async () => {
    let resolve!: (counts: Record<string, number>) => void;
    let first = true;
    render(NESTED, () => {
      if (first) {
        first = false;
        return Promise.resolve({ root: 2, "0": 3, "1": 30, "1.0": 20, "1.1": 10 });
      }
      return new Promise<Record<string, number>>((r) => {
        resolve = r;
      });
    });
    await flush();
    const el = () => container.querySelector('[data-node-count="root"]')!;
    expect(el().className).toContain("text-subtle-foreground");
    expect(el().getAttribute("aria-busy")).toBe(null);

    typeInto(container.querySelector<HTMLInputElement>('input[aria-label="Value"]')!, "zzz");
    // Still the full-contrast token, never an alpha-modified one, plus a cue
    // that does not depend on seeing a colour difference.
    expect(el().className).toContain("text-subtle-foreground");
    expect(el().className).not.toContain("text-subtle-foreground/");
    expect(el().className).toContain("italic");
    expect(el().getAttribute("aria-busy")).toBe("true");

    await flush();
    await act(async () => {
      resolve({ root: 9, "0": 9, "1": 9, "1.0": 9, "1.1": 9 });
    });
    expect(el().getAttribute("aria-busy")).toBe(null);
    expect(el().className).not.toContain("italic");
  });

  // Over the budget the server returns nothing, which on screen is
  // indistinguishable from a failed request unless the builder says so.
  it("explains the silence when the tree is past the node budget", async () => {
    const overBudget: Audience = {
      recordType: "PERSON",
      match: "ANY",
      conditions: Array.from({ length: MAX_COUNTED_NODES }, () => ({
        field: "name",
        op: "isNotEmpty" as ConditionOp,
      })),
    };
    render(overBudget, async () => ({}));
    await flush();

    expect(container.textContent).toContain(`more than ${MAX_COUNTED_NODES}`);
    expect(container.textContent).not.toContain("shows how many people it matches ON ITS OWN");
    expect(countsShown()).toEqual({});
  });

  it("keeps the normal note one clause under the budget", async () => {
    const atBudget: Audience = {
      recordType: "PERSON",
      match: "ANY",
      conditions: Array.from({ length: MAX_COUNTED_NODES - 1 }, () => ({
        field: "name",
        op: "isNotEmpty" as ConditionOp,
      })),
    };
    render(atBudget, async () => ({}));
    await flush();

    expect(container.textContent).toContain("shows how many people it matches ON ITS OWN");
    expect(container.textContent).not.toContain(`more than ${MAX_COUNTED_NODES}`);
  });

  it("keeps the previous numbers on screen, dimmed, while a fresh count is in flight", async () => {
    let resolve!: (counts: Record<string, number>) => void;
    let first = true;
    render(NESTED, () => {
      if (first) {
        first = false;
        return Promise.resolve({ root: 2, "0": 3, "1": 30, "1.0": 20, "1.1": 10 });
      }
      return new Promise<Record<string, number>>((r) => {
        resolve = r;
      });
    });
    await flush();
    expect(countsShown().root).toBe("Matches 2 people");
    expect(container.querySelector('[data-node-count="root"]')!.getAttribute("data-stale")).toBe(
      "false",
    );

    const value = container.querySelector<HTMLInputElement>('input[aria-label="Value"]')!;
    typeInto(value, "zzz");

    // Still showing the old numbers rather than blanking every row.
    expect(countsShown().root).toBe("Matches 2 people");
    expect(container.querySelector('[data-node-count="root"]')!.getAttribute("data-stale")).toBe(
      "true",
    );

    await flush();
    await act(async () => {
      resolve({ root: 9, "0": 9, "1": 9, "1.0": 9, "1.1": 9 });
    });
    expect(countsShown().root).toBe("Matches 9 people");
    expect(container.querySelector('[data-node-count="root"]')!.getAttribute("data-stale")).toBe(
      "false",
    );
  });
});
