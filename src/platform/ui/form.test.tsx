import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FormRow, RowField, ROW_WIDTH } from "./form";
import { Input } from "./input";

const render = (node: React.ReactElement) => renderToStaticMarkup(node);

describe("FormRow", () => {
  it("keeps its own flex classes and takes only outer spacing from the caller", () => {
    // Twenty-four write forms hand-wrote this row. If a caller can override the
    // flex classes we are back to twenty-four rows again -- with no
    // tailwind-merge in this repo, whichever class is emitted last would win.
    const out = render(<FormRow className="mt-4 border-t pt-4">x</FormRow>);
    expect(out).toContain("flex flex-wrap items-end gap-3");
    expect(out).toContain("mt-4 border-t pt-4");
  });
});

describe("RowField", () => {
  it("defaults to the control width, so a plain select never picks its own", () => {
    const out = render(
      <RowField label="Outcome">
        <Input name="outcome" />
      </RowField>,
    );
    expect(out).toContain(ROW_WIDTH.control);
  });

  it("gives each role exactly one class", () => {
    // Four roles, four classes. The eight fixed widths these replaced (w-28
    // through w-72) are what made the same Notes field 12rem on one form and
    // full-width on the next.
    const classes = Object.values(ROW_WIDTH);
    expect(new Set(classes).size).toBe(classes.length);
    for (const width of Object.keys(ROW_WIDTH) as (keyof typeof ROW_WIDTH)[]) {
      const out = render(
        <RowField label="Notes" width={width}>
          <Input name="notes" />
        </RowField>,
      );
      expect(out).toContain(ROW_WIDTH[width]);
    }
  });

  it("labels the control visibly, not by aria-label alone", () => {
    // Same rule as FilterField: "Select…" alone tells a sighted user nothing
    // about what is being chosen.
    const out = render(
      <RowField label="Your score">
        <Input name="score" />
      </RowField>,
    );
    expect(out).toContain("<label");
    expect(out).toContain("Your score");
  });

  it("passes hint and required through to Field", () => {
    const out = render(
      <RowField label="Comments" hint="Optional." required>
        <Input name="comments" />
      </RowField>,
    );
    expect(out).toContain("Optional.");
    expect(out).toContain('aria-required="true"');
  });
});
