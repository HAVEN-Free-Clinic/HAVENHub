// @vitest-environment jsdom
/**
 * The pending Epic queue on /support/epic batches requests into ONE YNHH ticket.
 * It was the only bulk surface in the app with no select-all and no count at
 * all: its boxes were uncontrolled `name="requestIds"` inputs, so a director
 * ticking twelve of forty and pressing Create had nothing on screen saying how
 * many were going in.
 *
 * The load-bearing property is the one these pin: what the form POSTS is exactly
 * what the operator ticked. Getting that wrong opens a ticket for the wrong
 * people.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PendingTab } from "./epic-request-tabs";
import type { PendingEpicRequestRow } from "@/modules/support/services/itcm";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const noop = async () => {};

function row(id: string, name: string): PendingEpicRequestRow {
  return {
    id,
    kind: "NEW",
    createdAt: new Date("2026-09-01T12:00:00Z"),
    notes: null,
    person: { id: `p-${id}`, name, epicId: null },
    techRequest: null,
  };
}

const ROWS = [row("r1", "Ada Lovelace"), row("r2", "Grace Hopper"), row("r3", "Katherine Johnson")];

let mounted: { container: HTMLDivElement; root: Root } | null = null;

function mount(rows: PendingEpicRequestRow[] = ROWS) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<PendingTab pending={rows} action={noop} cancelAction={noop} />));
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

/** What the form would actually POST. */
const postedIds = (c: HTMLElement) =>
  [...c.querySelectorAll<HTMLInputElement>('input[type="hidden"][name="requestIds"]')].map((i) => i.value);

const rowBox = (c: HTMLElement, name: string) =>
  c.querySelector<HTMLInputElement>(`input[aria-label="Select ${name}"]`)!;

const selectAll = (c: HTMLElement) =>
  [...c.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(
    (i) => !i.getAttribute("aria-label"),
  )!;

const click = (el: HTMLElement, shiftKey = false) =>
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey }));
  });

describe("the pending Epic queue", () => {
  it("posts nothing until something is ticked", () => {
    const c = mount();
    expect(postedIds(c)).toEqual([]);
    expect(c.textContent).toContain("0 of 3 selected");
  });

  it("posts exactly what was ticked", () => {
    const c = mount();
    click(rowBox(c, "Grace Hopper"));
    expect(postedIds(c)).toEqual(["r2"]);
    expect(c.textContent).toContain("1 of 3 selected");
  });

  it("select-all takes the whole queue, and untick takes it back", () => {
    const c = mount();
    click(selectAll(c));
    expect(postedIds(c)).toEqual(["r1", "r2", "r3"]);
    expect(c.textContent).toContain("3 of 3 selected");
    click(selectAll(c));
    expect(postedIds(c)).toEqual([]);
  });

  it("shift-click takes the range, which forty rows need", () => {
    const c = mount();
    click(rowBox(c, "Ada Lovelace"));
    click(rowBox(c, "Katherine Johnson"), true);
    expect(postedIds(c)).toEqual(["r1", "r2", "r3"]);
  });

  it("says 'some' on the header when the selection is partial", () => {
    const c = mount();
    click(rowBox(c, "Grace Hopper"));
    expect(selectAll(c).indeterminate).toBe(true);
    expect(selectAll(c).checked).toBe(false);
    click(selectAll(c));
    expect(selectAll(c).indeterminate).toBe(false);
    expect(selectAll(c).checked).toBe(true);
  });
});
