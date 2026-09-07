import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Checkbox } from "./checkbox";
import { Radio } from "./radio";

const render = (node: React.ReactElement) => renderToStaticMarkup(node);

describe("Checkbox", () => {
  it("wraps a labelled control in a <label>, so the text is associated with the box", () => {
    // 73 call sites hand-built this row, most putting a bare <span> beside the
    // input, which associates nothing.
    const out = render(<Checkbox name="x" label="Immediate risk only" />);
    expect(out).toContain("<label");
    expect(out).toContain("Immediate risk only");
    expect(out).toContain('type="checkbox"');
  });

  it("returns a bare control when unlabelled, so table-cell callers are unchanged", () => {
    const out = render(<Checkbox name="x" />);
    expect(out).not.toContain("<label");
    expect(out).toContain('type="checkbox"');
  });

  it("uses the same row shape as Radio, which the two must not diverge on", () => {
    // The controls sit side by side often enough that any difference reads as a
    // bug. Radio already shipped this; Checkbox is catching up to it.
    const check = render(<Checkbox name="a" label="One" />);
    const radio = render(<Radio name="b" label="One" />);
    const rowClass = (html: string) => html.match(/<label class="([^"]*)"/)?.[1] ?? "";
    expect(rowClass(check)).toContain("flex");
    expect(rowClass(check)).toContain("gap-2");
    expect(rowClass(check)).toContain("text-sm");
    expect(rowClass(radio)).toContain("gap-2");
    expect(rowClass(radio)).toContain("text-sm");
  });

  it("renders a hint under the label, in the muted token", () => {
    const out = render(
      <Checkbox name="x" label="Send a copy" hint="Goes to the department inbox." />,
    );
    expect(out).toContain("Goes to the department inbox.");
    expect(out).toContain("text-subtle-foreground");
  });

  it("switches to top alignment once a hint can wrap to two lines", () => {
    // items-center would drag the box to the vertical middle of a two-line block.
    expect(render(<Checkbox name="x" label="A" />)).toContain("items-center");
    expect(render(<Checkbox name="x" label="A" hint="B" />)).toContain("items-start");
  });

  it("keeps the focus ring and passes input props through", () => {
    const out = render(<Checkbox name="immediateRisk" label="A" defaultChecked disabled />);
    expect(out).toContain("focus-visible:outline-brand");
    expect(out).toContain('name="immediateRisk"');
    expect(out).toContain("checked");
    expect(out).toContain("disabled");
  });
});
