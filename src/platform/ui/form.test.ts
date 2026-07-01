import { describe, expect, it } from "vitest";
import { FormSection, FormActions } from "./form";

describe("FormSection", () => {
  it("renders a border-reset fieldset with an uppercase legend", () => {
    const el = FormSection({ title: "Contact details", children: null });
    expect(el.type).toBe("fieldset");
    expect(el.props.className).toContain("border-0");
    const [legend] = el.props.children;
    expect(legend.props.children).toBe("Contact details");
    expect(legend.props.className).toContain("uppercase");
    expect(legend.props.className).toContain("text-muted-foreground");
  });
});

describe("FormActions", () => {
  it("is a left-aligned flex row by default", () => {
    const el = FormActions({ children: null });
    expect(el.props.className).toContain("flex");
    expect(el.props.className).not.toContain("justify-end");
  });

  it("right-aligns when align=end", () => {
    expect(FormActions({ children: null, align: "end" }).props.className).toContain(
      "justify-end",
    );
  });
});
