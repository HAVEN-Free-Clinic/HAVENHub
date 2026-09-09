// @vitest-environment jsdom
/**
 * The selection model three bulk surfaces now share. These are the parts that
 * only exist in a live DOM: the shift-click range, the anchor that has to be
 * read before the ref moves, and the reconciliation that drops a selected row
 * once it leaves the list.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useBulkSelection } from "./use-bulk-selection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Row = { id: string; group: "a" | "b"; locked?: boolean };

const ROWS: Row[] = [
  { id: "1", group: "a" },
  { id: "2", group: "a" },
  { id: "3", group: "a", locked: true },
  { id: "4", group: "b" },
  { id: "5", group: "b" },
];

/** A stand-in for the three real tables: rows, a header box, per-group boxes. */
function Probe({ initialRows = ROWS }: { initialRows?: Row[] }) {
  const [rows, setRows] = useState(initialRows);
  const selection = useBulkSelection({
    rows,
    idOf: (r) => r.id,
    selectable: (r) => !r.locked,
  });
  const groupIds = rows.filter((r) => r.group === "a" && !r.locked).map((r) => r.id);
  return (
    <div>
      <output id="ids">{selection.ids.join(",")}</output>
      <output id="flags">
        {selection.allSelected ? "all" : ""}
        {selection.someSelected ? "some" : ""}
      </output>
      <output id="group">
        {selection.allOf(groupIds) ? "gall" : ""}
        {selection.someOf(groupIds) ? "gsome" : ""}
      </output>
      <button id="header" onClick={selection.toggleAll} />
      <button id="group-on" onClick={() => selection.setMany(groupIds, true)} />
      <button id="group-off" onClick={() => selection.setMany(groupIds, false)} />
      <button id="clear" onClick={selection.clear} />
      <button id="drop" onClick={() => setRows((r) => r.filter((x) => x.id !== "2"))} />
      {rows.map((r) => (
        <button
          key={r.id}
          id={`row-${r.id}`}
          data-on={selection.has(r.id) ? "yes" : "no"}
          onClick={(e) => selection.toggle(r.id, e.shiftKey)}
        />
      ))}
    </div>
  );
}

let mounted: { container: HTMLDivElement; root: Root } | null = null;

function mount(node: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
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

const text = (c: HTMLElement, id: string) => c.querySelector(`#${id}`)!.textContent;
const click = (c: HTMLElement, id: string, shiftKey = false) =>
  act(() => {
    c.querySelector<HTMLButtonElement>(`#${id}`)!.dispatchEvent(
      new MouseEvent("click", { bubbles: true, shiftKey }),
    );
  });

describe("useBulkSelection", () => {
  it("extends a shift-click across the range instead of toggling one row", () => {
    // The behaviour the offboarding tabs did not have: picking twenty people
    // out of a cohort was twenty individual clicks.
    const c = mount(<Probe />);
    click(c, "row-1");
    click(c, "row-5", true);
    expect(text(c, "ids")).toBe("1,2,4,5");
  });

  it("extends from the row the range STARTED at, not the one just clicked", () => {
    // setSelected only schedules its updater, so reading the anchor ref from
    // inside it would see the reassignment at the bottom of toggle and every
    // shift-click would extend from itself, selecting exactly one row.
    const c = mount(<Probe />);
    click(c, "row-1");
    click(c, "row-4", true);
    expect(text(c, "ids")).toBe("1,2,4");
    // A second shift-click re-anchors to the last click, so this extends 4 -> 5.
    click(c, "row-5", true);
    expect(text(c, "ids")).toBe("1,2,4,5");
  });

  it("only ever adds across a range, so dragging back does not punch holes", () => {
    const c = mount(<Probe />);
    click(c, "header");
    expect(text(c, "ids")).toBe("1,2,4,5");
    click(c, "row-1");
    click(c, "row-5", true);
    expect(text(c, "ids")).toBe("1,2,4,5");
  });

  it("never selects a row that cannot be acted on", () => {
    // Row 3 is locked. It is skipped by select-all and by a range that spans it.
    const c = mount(<Probe />);
    click(c, "header");
    expect(text(c, "ids")).not.toContain("3");
    click(c, "clear");
    click(c, "row-1");
    click(c, "row-4", true);
    expect(text(c, "ids")).toBe("1,2,4");
  });

  it("drops a row from the selection once it leaves the list", () => {
    // revalidatePath re-renders these tables with fresh rows but never remounts
    // them, so the raw Set outlives the people in it. Submitting a stale id
    // would rerun a bulk offboard on someone already offboarded.
    const c = mount(<Probe />);
    click(c, "header");
    expect(text(c, "ids")).toBe("1,2,4,5");
    click(c, "drop");
    expect(text(c, "ids")).toBe("1,4,5");
  });

  it("says 'some' only when the selection is partial", () => {
    const c = mount(<Probe />);
    expect(text(c, "flags")).toBe("");
    click(c, "row-1");
    expect(text(c, "flags")).toBe("some");
    click(c, "header");
    expect(text(c, "flags")).toBe("all");
  });

  it("scopes a group header to its own group", () => {
    // The offboarding transition tab renders a header box per bucket. A full
    // selection in bucket A must not report the whole table as selected.
    const c = mount(<Probe />);
    click(c, "group-on");
    expect(text(c, "group")).toBe("gall");
    expect(text(c, "flags")).toBe("some");
    click(c, "group-off");
    expect(text(c, "ids")).toBe("");
  });

  it("preselects from `initial` at mount and no later", () => {
    function Preselected() {
      const [rows, setRows] = useState(ROWS);
      const s = useBulkSelection({
        rows,
        idOf: (r) => r.id,
        initial: (r) => r.group === "b",
      });
      return (
        <div>
          <output id="ids">{s.ids.join(",")}</output>
          <button id="clear" onClick={s.clear} />
          <button id="drop" onClick={() => setRows((r) => r.filter((x) => x.id !== "1"))} />
        </div>
      );
    }
    const c = mount(<Preselected />);
    expect(text(c, "ids")).toBe("4,5");
    click(c, "clear");
    // A re-render with different rows must NOT re-run the preselection: it would
    // resurrect a selection the operator just cleared.
    click(c, "drop");
    expect(text(c, "ids")).toBe("");
  });
});
