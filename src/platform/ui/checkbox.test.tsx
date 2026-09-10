import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Checkbox, CheckboxGroup } from "./checkbox";
import { Radio, RadioGroup } from "./radio";

const render = (node: React.ReactElement) => renderToStaticMarkup(node);
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

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

  it("the xs row still clears the 24px floor", () => {
    // xs exists for the dense director control strip (the speed-review "Show
    // handled" toggles, the campaign audience builder's Terms chips) where a
    // 44px row would restructure the header it sits in. It is a smaller row on
    // purpose, and it is still above SC 2.5.8's floor.
    const out = render(<Checkbox name="a" size="xs" label="Show handled" />);
    const row = out.match(/<label class="([^"]*)"/)?.[1] ?? "";
    expect(row).toContain("min-h-6");
    expect(row).toContain("text-xs");
    expect(row).toContain("-my-0.5");
    expect(row).not.toContain("min-h-11");
  });

  it("does not move the default row by adding a size", () => {
    // ~65 rows render without a size. This is what stops the lookup refactor
    // quietly redefining what they get.
    const row = render(<Checkbox name="a" label="One" />).match(/<label class="([^"]*)"/)?.[1] ?? "";
    for (const cls of ["min-h-11", "py-1", "-my-1", "text-sm", "gap-2"]) {
      expect(row).toContain(cls);
    }
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

describe("CheckboxGroup", () => {
  const groupClass = (html: string) => html.match(/<fieldset class="([^"]*)"/)?.[1] ?? "";
  const legendClass = (html: string) => html.match(/<legend class="([^"]*)"/)?.[1] ?? "";

  it("names the group with a real legend", () => {
    // Six lists were a bare run of checkboxes under a <p>, a <span>, or nothing
    // at all, so a screen reader read the options with no idea what question
    // they answered.
    const out = render(
      <CheckboxGroup legend="Department scope">
        <Checkbox name="d" label="A" />
      </CheckboxGroup>,
    );
    expect(out).toContain("<fieldset");
    expect(out).toContain("<legend");
    expect(out).toContain("Department scope");
  });

  it("keeps the name when the legend is visually hidden", () => {
    // The tempting wrong fix for a visible stutter (the EHS card already shows
    // "Department scope" in its SectionHeader) is to delete the legend, which
    // silently un-names the group again.
    const out = render(
      <CheckboxGroup legend="Department scope" hideLegend>
        <Checkbox name="d" label="A" />
      </CheckboxGroup>,
    );
    expect(out).toContain("<legend");
    expect(out).toContain("Department scope");
    expect(legendClass(out)).toContain("sr-only");
  });

  it("uses the same legend scale as Field and RadioGroup", () => {
    // Guards against a third legend type scale appearing. Same string as
    // radio.tsx's group label and input.tsx's Field label.
    const out = render(
      <CheckboxGroup legend="Departments">
        <Checkbox name="d" label="A" />
      </CheckboxGroup>,
    );
    for (const cls of ["text-xs", "font-medium", "text-muted-foreground"]) {
      expect(legendClass(out)).toContain(cls);
    }
  });

  it("owns the legend gap in exactly one place", () => {
    // The gap belongs to the fieldset's space-y-2 and NOWHERE else. A
    // margin-bottom on the legend as well would double it: space-y-* is
    // `> :not([hidden]) ~ :not([hidden])` and the legend is the first child, so
    // the first option is already a sibling it targets. Single ownership is
    // also what makes this class-for-class identical to the fieldset
    // roster-panel.tsx used to hand-roll.
    const out = render(
      <CheckboxGroup legend="Departments">
        <Checkbox name="d" label="A" />
      </CheckboxGroup>,
    );
    expect(groupClass(out)).toContain("space-y-2");
    expect(legendClass(out)).not.toMatch(/\bmb-/);
  });

  it("adds no spacing at all when the legend is hidden", () => {
    // sr-only takes the legend out of flow, but the sibling selector does not
    // care: space-y-2 would still hand the single wrapped child 8px of
    // margin-top that the markup does not have today, so the wrapper would not
    // be inert after all.
    const out = render(
      <CheckboxGroup legend="Members to add" hideLegend>
        <div>rows</div>
      </CheckboxGroup>,
    );
    expect(groupClass(out)).not.toContain("space-y-2");
  });
});

/**
 * Source guards. These read the repo rather than rendering, because what they
 * protect is which CALL SITES adopted the primitive, and nothing in a render
 * can see that.
 */
describe("checkbox call sites", () => {
  it("names both department-scope lists and starts them at one column", () => {
    // /volunteers/ehs/manage/<id> and /learning/manage/<id> render the same
    // department list. At 375px a full department name ("Care Coordination:
    // Reproductive Health") does not fit in a ~170px column, so the two-column
    // grid must not start until sm.
    for (const p of [
      "src/app/(app)/volunteers/ehs/manage/[trainingId]/page.tsx",
      "src/app/(app)/learning/manage/[courseId]/page.tsx",
    ]) {
      const src = read(p);
      expect(src, `${p} must name its department list`).toContain("CheckboxGroup");
      expect(src, `${p} must not force two columns at phone width`).not.toContain(
        "grid grid-cols-2 gap-1",
      );
    }
  });

  /**
   * Every `<label>` that wraps a `<Checkbox>` by hand, and why each survivor is
   * allowed to. Anything not listed here is a row that should be using the
   * primitive's `label` prop, which brings the 44px (or `size="xs"` 24px) target
   * with it.
   */
  const HAND_ROLLED = new Map<string, { count: number; why: string }>([
    ["src/app/(app)/schedule/page.tsx", { count: 1, why: "availability pill: geometry is a documented trade in availability-pill.ts" }],
    ["src/modules/schedule/components/attending-portal-section.tsx", { count: 1, why: "availability pill, same shared class" }],
    ["src/modules/schedule/components/builder-availability-view.tsx", { count: 1, why: "builder availability pill, same shared class" }],
    ["src/modules/recruitment/components/field-preview.tsx", { count: 3, why: "already hand-sets min-h-[44px]" }],
    ["src/app/(app)/recruitment/cycles/new/page.tsx", { count: 1, why: "py-1 plus a two-line label, already above the floor" }],
    ["src/app/(app)/recruitment/cycles/[id]/builder/field-card.tsx", { count: 2, why: "py-2 / py-1, already above the floor" }],
    ["src/app/(app)/recruitment/interviews/[interviewId]/add-panelist-form.tsx", { count: 1, why: "py-2, already above the floor" }],
    ["src/app/(app)/outreach/campaigns/[id]/timing-actions.tsx", { count: 1, why: "wrapping two-part label, already above the floor" }],
    ["src/app/(app)/incidents/concern-types-fieldset.tsx", { count: 1, why: "'Label - help' is one inline line by design; label+hint would make section 1 markedly taller" }],
    ["src/modules/support/components/epic-request-form.tsx", { count: 1, why: "full-width clickable row with px-3 and hover:bg-muted, which the primitive's row cannot express" }],
    ["src/app/(app)/learning/manage/[courseId]/UploadPackageForm.tsx", { count: 1, why: "multi-line explanatory row, already ~60px, needs items-start" }],
  ]);

  it("has no hand-rolled checkbox rows outside the allowlist", () => {
    const found = new Map<string, number>();
    const walk = (dir: string) => {
      for (const entry of readdirSync(join(process.cwd(), dir))) {
        const rel = `${dir}/${entry}`;
        if (statSync(join(process.cwd(), rel)).isDirectory()) {
          walk(rel);
          continue;
        }
        if (!entry.endsWith(".tsx") || entry.endsWith(".test.tsx")) continue;
        const lines = read(rel).split("\n");
        lines.forEach((line, i) => {
          if (!line.includes("<Checkbox")) return;
          // Look back five lines: that spans the widest real case, a <label>
          // with its className on its own line and a multi-prop Checkbox under it.
          for (let back = 1; back <= 5 && i - back >= 0; back++) {
            if (lines[i - back].includes("<label")) {
              found.set(rel, (found.get(rel) ?? 0) + 1);
              return;
            }
          }
        });
      }
    };
    walk("src/app");
    walk("src/modules");

    const unexpected = [...found].filter(([p, n]) => HAND_ROLLED.get(p)?.count !== n);
    expect(
      unexpected,
      "Use <Checkbox label={...} /> instead of wrapping it in your own <label>: the primitive brings the WCAG 2.2 SC 2.5.8 target with it. If the row genuinely cannot use it, add it to HAND_ROLLED with a reason.",
    ).toEqual([]);
    // ...and the reverse, so a converted site drops out of the allowlist too.
    expect([...HAND_ROLLED.keys()].filter((p) => !found.has(p))).toEqual([]);
  });
});
