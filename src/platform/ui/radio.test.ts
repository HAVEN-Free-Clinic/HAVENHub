import { describe, expect, it } from "vitest";
import { Radio, RadioGroup } from "./radio";

describe("Radio", () => {
  it("renders a real radio input with the brand outline focus ring", () => {
    const el = Radio({ label: "Yes", name: "answer", value: "yes" });
    expect(el.type).toBe("label");
    const [input, span] = el.props.children;
    expect(input.props.type).toBe("radio");
    expect(input.props.name).toBe("answer");
    expect(input.props.value).toBe("yes");
    expect(input.props.className).toContain("accent-brand");
    expect(input.props.className).toContain("outline-brand");
    expect(span.props.children).toBe("Yes");
  });

  it("renders no label span when label is omitted", () => {
    const el = Radio({ name: "answer", value: "yes" });
    const children = el.props.children;
    const second = Array.isArray(children) ? children[1] : undefined;
    expect(second).toBeFalsy();
  });
});

describe("RadioGroup", () => {
  it("uses role=radiogroup and renders an optional legend", () => {
    const el = RadioGroup({ legend: "Pick one", children: null });
    expect(el.props.role).toBe("radiogroup");
    const [legend] = el.props.children;
    expect(legend.props.children).toBe("Pick one");
    expect(legend.props.className).toContain("text-muted-foreground");
  });
});
