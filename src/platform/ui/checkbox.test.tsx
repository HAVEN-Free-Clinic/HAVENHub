import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Checkbox } from "./checkbox";
import { Radio, RadioGroup } from "./radio";

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

  /**
   * The regression this guards. `Checkbox` carries no "use client" and fifteen
   * SERVER components render it, and React refuses to serialise a ref from a
   * server render at all: "Refs cannot be used in Server Components, nor passed
   * to Client Components." Attaching the indeterminate callback ref
   * unconditionally threw on every admin page holding a checkbox -- /admin/roles,
   * /admin/people/[id], /admin/terms/[id] -- and the e2e shard covering them
   * failed on ten timed-out navigations rather than on anything that named a
   * checkbox.
   *
   * These read the element rather than its HTML because a ref leaves no trace in
   * markup: renderToStaticMarkup renders the same string either way.
   */
  const inputOf = (el: React.ReactElement): React.ReactElement =>
    el.type === "input"
      ? el
      : // labelled: <label>{input}<span/></label>
        (el.props as { children: React.ReactElement[] }).children[0];

  const refOf = (el: React.ReactElement) =>
    (inputOf(el).props as { ref?: unknown }).ref;

  it("attaches NO ref when nothing needs one, which is the server case", () => {
    expect(refOf(Checkbox({ name: "x" }) as React.ReactElement)).toBeUndefined();
    expect(refOf(Checkbox({ name: "x", label: "One" }) as React.ReactElement)).toBeUndefined();
  });

  it("attaches one when there is an indeterminate to apply or a ref to forward", () => {
    // Both only ever come from a client component, which is what makes the
    // conditional safe rather than a way of losing the feature.
    expect(refOf(Checkbox({ name: "x", indeterminate: false }) as React.ReactElement)).toBeTypeOf("function");
    expect(refOf(Checkbox({ name: "x", ref: () => {} }) as React.ReactElement)).toBeTypeOf("function");
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

  it("clears the 24px touch-target floor, and Radio clears it too", () => {
    // WCAG 2.2 SC 2.5.8. The labelled row was ~20px tall, and these stack in
    // dense columns -- a department scope list, a notification-preference list
    // -- where a mis-tap sets the NEIGHBOURING option rather than missing.
    // Asserted for both, because the row shape is shared and a fix to one alone
    // is the divergence the case above exists to prevent.
    const rowClass = (html: string) => html.match(/<label class="([^"]*)"/)?.[1] ?? "";
    for (const html of [render(<Checkbox name="a" label="One" />), render(<Radio name="b" label="One" />)]) {
      expect(rowClass(html)).toContain("min-h-11");
      expect(rowClass(html)).toContain("py-1");
    }
  });

  it("grows the target without pushing the rows apart", () => {
    // The negative margin is what keeps the visual rhythm: without it, adding
    // padding to ~65 rows would visibly loosen every dense list in the app.
    expect(render(<Checkbox name="a" label="One" />)).toContain("-my-1");
  });

  it("does not set indeterminate unless asked", () => {
    // `indeterminate` is a DOM property, not an attribute, so it never appears
    // in static markup. What CAN be asserted here is that adding the prop did
    // not change the rendered element for the ~90 call sites that omit it.
    const plain = render(<Checkbox name="a" label="One" />);
    expect(plain).not.toContain("indeterminate");
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

describe("RadioGroup naming", () => {
  it("names the ARIA group, which was announced anonymously", () => {
    // role="radiogroup" IS an ARIA group, and a group with no accessible name
    // is announced as an anonymous one -- so a screen reader said "radio group"
    // and then read the options with no idea what question they answered. The
    // legend was rendered as a bare span: visible, and invisible to AT.
    const out = render(
      <RadioGroup legend="Visibility">
        <Radio name="v" label="Everyone" />
      </RadioGroup>,
    );
    const labelledBy = out.match(/role="radiogroup"[^>]*aria-labelledby="([^"]+)"/)?.[1];
    expect(labelledBy).toBeTruthy();
    // ...and it must point at something that actually exists in the markup.
    expect(out).toContain(`id="${labelledBy}"`);
    expect(out).toMatch(new RegExp(`id="${labelledBy}"[^>]*>Visibility<`));
  });

  it("leaves an unnamed group unnamed rather than inventing a name", () => {
    // The two legend-less call sites sit inside a FormSection, which is already
    // a real fieldset with a real legend. Naming the inner group as well would
    // make AT announce the question twice.
    const out = render(
      <RadioGroup>
        <Radio name="v" label="Everyone" />
      </RadioGroup>,
    );
    expect(out).not.toContain("aria-labelledby");
  });
});
