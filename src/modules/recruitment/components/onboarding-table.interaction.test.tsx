// @vitest-environment jsdom
/**
 * Interaction tests for OnboardingTable's selection model. Static markup is
 * covered in onboarding-table.test.tsx; these cover the parts that only exist
 * in a live DOM: the indeterminate header property, shift-click ranges, and
 * selection pruning when a filter changes.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { OnboardingTable } from "./onboarding-table";
import type { OnboardingRow } from "@/modules/recruitment/engine/onboarding-rows";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const noop = () => {};
let mounted: { container: HTMLDivElement; root: Root } | null = null;

function mount(rows: OnboardingRow[]) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <OnboardingTable rows={rows} cycleId="cy1" sendLinks={noop} promote={noop} withdraw={noop} />,
    );
  });
  mounted = { container, root };
  return container;
}

afterEach(() => {
  if (mounted) {
    const { container, root } = mounted;
    act(() => root.unmount());
    container.remove();
    mounted = null;
  }
});

function row(over: Partial<OnboardingRow> = {}): OnboardingRow {
  return {
    acceptanceId: "a1", contractId: "c1", firstName: "Ona", lastName: "Boarder",
    departmentCode: "SRHD", state: "SUBMITTED", onRoster: false, customAnswers: [],
    ...over,
  };
}

const rowBoxes = (c: HTMLElement) =>
  [...c.querySelectorAll<HTMLInputElement>('input[name="acceptanceId"]')];
const headerBox = (c: HTMLElement) =>
  c.querySelector<HTMLInputElement>('input[aria-label="Select all"]')!;
/**
 * Find an action-bar button by its label.
 *
 * Matches on the "(N)" count suffix deliberately: the per-row Withdraw buttons
 * render BEFORE the action bar and their text also starts with "Withdraw", so a
 * bare startsWith would return a row button instead of the bulk one.
 */
const button = (c: HTMLElement, label: string) =>
  [...c.querySelectorAll("button")].find((b) => b.textContent?.startsWith(`${label} (`))!;
const click = (el: HTMLElement, init: MouseEventInit = {}) =>
  act(() => { el.dispatchEvent(new MouseEvent("click", { bubbles: true, ...init })); });

const THREE = [
  row({ acceptanceId: "a1", state: "SUBMITTED", departmentCode: "SRHD" }),
  row({ acceptanceId: "a2", state: "EXPIRED", departmentCode: "PCAR" }),
  row({ acceptanceId: "a3", state: "NO_CONTRACT", departmentCode: "SRHD" }),
];

describe("OnboardingTable selection", () => {
  it("selects every visible selectable row from the header checkbox", () => {
    const c = mount(THREE);
    click(headerBox(c));
    expect(rowBoxes(c).every((b) => b.checked)).toBe(true);
  });

  it("puts the header checkbox in the indeterminate state on a partial selection", () => {
    const c = mount(THREE);
    click(rowBoxes(c)[0]);
    expect(headerBox(c).indeterminate).toBe(true);
    expect(headerBox(c).checked).toBe(false);
  });

  it("clears the indeterminate state once everything is selected", () => {
    const c = mount(THREE);
    click(headerBox(c));
    expect(headerBox(c).indeterminate).toBe(false);
    expect(headerBox(c).checked).toBe(true);
  });

  it("selects a range on shift-click", () => {
    const c = mount(THREE);
    click(rowBoxes(c)[0]);
    click(rowBoxes(c)[2], { shiftKey: true });
    expect(rowBoxes(c).map((b) => b.checked)).toEqual([true, true, true]);
  });

  it("counts eligibility per action", () => {
    const c = mount(THREE);
    click(headerBox(c));
    // a1 SUBMITTED, a2 EXPIRED, a3 NO_CONTRACT
    expect(button(c, "Send links").textContent).toContain("(2)");
    expect(button(c, "Promote").textContent).toContain("(1)");
    expect(button(c, "Withdraw").textContent).toContain("(2)");
  });

  it("disables an action with no eligible row in the selection", () => {
    const c = mount([row({ acceptanceId: "a1", state: "NO_CONTRACT" })]);
    click(rowBoxes(c)[0]);
    expect(button(c, "Promote").hasAttribute("disabled")).toBe(true);
    expect(button(c, "Send links").hasAttribute("disabled")).toBe(false);
  });

  // A hidden selection would let Withdraw destroy contracts the operator cannot
  // see at the moment they confirm.
  it("prunes the selection to visible rows when a filter changes", () => {
    const c = mount(THREE);
    click(headerBox(c));
    const dept = c.querySelector<HTMLSelectElement>('select[aria-label="Filter by department"]')!;
    act(() => {
      dept.value = "PCAR";
      dept.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(rowBoxes(c)).toHaveLength(1);
    expect(button(c, "Withdraw").textContent).toContain("(1)");
    // Row count and the action counts both derive from the VISIBLE rows, so they
    // stay correct even if the selection kept its hidden members. Only these read
    // effectiveSelected.size directly, so they are what fails if the intersection
    // is ever dropped.
    expect(c.textContent).toContain("1 selected");
    expect(c.textContent).not.toContain("3 selected");
    expect(headerBox(c).checked).toBe(true);
    expect(headerBox(c).indeterminate).toBe(false);
  });

  it("reports the selected count and clears it", () => {
    const c = mount(THREE);
    click(headerBox(c));
    expect(c.textContent).toContain("3 selected");
    const clear = [...c.querySelectorAll("button")].find((b) => b.textContent === "Clear")!;
    click(clear);
    expect(rowBoxes(c).some((b) => b.checked)).toBe(false);
  });

  // The form now contains a text input, so a browser's HTML implicit
  // submission would activate the form's first submit button in tree order
  // (Send links) when Enter is pressed here -- an operator narrowing a wide
  // selection with search and then hitting Enter out of habit would email
  // links to everyone checked with no confirmation. jsdom does not simulate
  // that native implicit-submission behavior, so this asserts the guard's own
  // mechanism directly: the keydown handler must call preventDefault to stop
  // it, and only for Enter.
  it("prevents Enter in the search box from submitting the form", () => {
    const c = mount(THREE);
    const search = c.querySelector<HTMLInputElement>('input[aria-label="Search applicants by name"]')!;
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    act(() => { search.dispatchEvent(enter); });
    expect(enter.defaultPrevented).toBe(true);
  });

  it("does not swallow other keys in the search box", () => {
    const c = mount(THREE);
    const search = c.querySelector<HTMLInputElement>('input[aria-label="Search applicants by name"]')!;
    const letter = new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true });
    act(() => { search.dispatchEvent(letter); });
    expect(letter.defaultPrevented).toBe(false);
  });
});
