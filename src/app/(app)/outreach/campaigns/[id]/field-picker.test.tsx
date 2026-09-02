// @vitest-environment jsdom
/**
 * Interaction tests for FieldPicker, run against the REAL PERSON_FIELD_VIEWS
 * (not a hand-built fixture) so the search/group behavior is exercised at the
 * scale the audience engine actually has -- several dozen fields across under
 * a dozen groups. See audience-builder.test.tsx for why this is bare
 * createRoot + act() rather than @testing-library/react: this repo has none.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PERSON_FIELD_VIEWS } from "@/platform/email/audience/person-fields";
import { FieldPicker } from "./field-picker";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no layout, so scrollIntoView (used to keep the keyboard-highlighted
// option visible) is missing; stub it, same as every other consumer here does.
if (!window.HTMLElement.prototype.scrollIntoView) {
  window.HTMLElement.prototype.scrollIntoView = () => {};
}

let container: HTMLDivElement;
let root: Root;

function render(value: string, onChange: (key: string) => void) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<FieldPicker fields={PERSON_FIELD_VIEWS} value={value} onChange={onChange} />);
  });
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function trigger(): HTMLButtonElement {
  // The trigger's aria-label carries the current selection (see field-picker.tsx),
  // so it is found by its stable role/attribute instead of exact text.
  return container.querySelector('button[aria-haspopup="listbox"]') as HTMLButtonElement;
}

function searchInput(): HTMLInputElement | null {
  return container.querySelector('input[role="combobox"]');
}

function openPicker() {
  act(() => trigger().click());
}

function typeQuery(text: string) {
  const input = searchInput()!;
  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    nativeSetter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function pressKey(key: string) {
  act(() => {
    searchInput()!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

function optionLabels(): string[] {
  return [...container.querySelectorAll('[role="option"]')].map((o) => o.textContent ?? "");
}

function groupHeadings(): string[] {
  return [...container.querySelectorAll('[role="group"]')].map(
    (g) => g.firstElementChild?.textContent ?? "",
  );
}

describe("FieldPicker search", () => {
  it("narrows to fields whose label contains the typed substring", () => {
    render("netId", () => {});
    openPicker();
    typeQuery("full name");
    expect(optionLabels()).toEqual(["Full name"]);
  });

  it("surfaces a whole group by its NAME even when no field label matches", () => {
    // None of the four shift-count labels contain the word "schedule" -- that
    // is exactly the failure mode a naive label-only filter would have.
    render("netId", () => {});
    openPicker();
    typeQuery("Schedule");
    expect(optionLabels().sort()).toEqual(
      [
        "Shifts assigned this term",
        "Clinic days attended this term",
        "Assigned shifts not attended",
        "Upcoming assigned shifts",
      ].sort(),
    );
  });

  it("does not render the heading for a group with no matches", () => {
    render("netId", () => {});
    openPicker();
    typeQuery("Schedule");
    expect(groupHeadings()).toEqual(["Schedule"]);
  });
});

describe("FieldPicker keyboard", () => {
  it("Enter selects the highlighted match and calls onChange with its key", () => {
    const onChange = vi.fn();
    render("netId", onChange);
    openPicker();
    typeQuery("full name");
    pressKey("Enter");
    expect(onChange).toHaveBeenCalledWith("name");
    // Selecting closes the popover.
    expect(searchInput()).toBeNull();
  });

  it("ArrowDown moves the highlight before Enter selects", () => {
    const onChange = vi.fn();
    render("netId", onChange);
    openPicker();
    // The group name "Recruitment" matches all three of its fields, in their
    // registered order: appliedToCycle, acceptedInCycle, subcommittee.
    typeQuery("Recruitment");
    expect(optionLabels()).toEqual([
      "Applied to recruitment cycle",
      "Accepted in recruitment cycle",
      "Assigned subcommittee",
    ]);
    pressKey("ArrowDown");
    pressKey("Enter");
    expect(onChange).toHaveBeenCalledWith("acceptedInCycle");
  });

  it("Escape closes without calling onChange, leaving the trigger showing the old value", () => {
    const onChange = vi.fn();
    render("netId", onChange);
    openPicker();
    typeQuery("full name");
    pressKey("Escape");
    expect(onChange).not.toHaveBeenCalled();
    expect(searchInput()).toBeNull();
    expect(trigger().textContent).toContain("NetID");
  });
});

describe("FieldPicker unknown stored field", () => {
  it("renders a removable unknown instead of crashing", () => {
    const onChange = vi.fn();
    expect(() => render("aFieldThatNoLongerExists", onChange)).not.toThrow();
    expect(trigger().textContent).toContain("Unknown field");

    const removeButton = container.querySelector(
      'button[aria-label="Remove unknown field"]',
    ) as HTMLButtonElement;
    expect(removeButton).toBeTruthy();

    act(() => removeButton.click());
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("still opens and lets a real field be picked from an unknown starting value", () => {
    const onChange = vi.fn();
    render("aFieldThatNoLongerExists", onChange);
    openPicker();
    typeQuery("full name");
    pressKey("Enter");
    expect(onChange).toHaveBeenCalledWith("name");
  });
});
