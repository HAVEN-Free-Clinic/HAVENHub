import { describe, expect, it } from "vitest";
import { ReadonlyField, Field } from "./input";

describe("ReadonlyField", () => {
  it("renders the label as muted text and the value as static foreground text", () => {
    const el = ReadonlyField({ label: "Epic ID", value: "CARNEYJU" });
    expect(el.type).toBe("div");
    const [labelSpan, valueP] = el.props.children;
    expect(labelSpan.props.children).toBe("Epic ID");
    expect(labelSpan.props.className).toContain("text-muted-foreground");
    expect(valueP.type).toBe("p");
    expect(valueP.props.children).toBe("CARNEYJU");
    expect(valueP.props.className).toContain("border-b");
    expect(valueP.props.className).toContain("text-foreground");
  });

  it("shows a 'Not set' placeholder when value is empty", () => {
    const el = ReadonlyField({ label: "Phone", value: "" });
    const valueP = el.props.children[1];
    expect(JSON.stringify(valueP.props.children)).toContain("Not set");
  });

  it("renders an optional hint as subtle text", () => {
    const el = ReadonlyField({ label: "Epic ID", value: "X", hint: "Contact IT" });
    const hint = el.props.children[2];
    expect(hint.props.children).toBe("Contact IT");
    expect(hint.props.className).toContain("text-subtle-foreground");
  });
});

describe("Field", () => {
  it("renders a required marker when required is true", () => {
    const el = Field({ label: "Name", required: true, children: null });
    const labelEl = el.props.children[0];
    const labelSpan = labelEl.props.children[0];
    const [, marker] = labelSpan.props.children;
    expect(marker).toBeTruthy();
    // Exact, not toContain("text-critical"): the vivid `text-critical` is a
    // SUBSTRING of `text-critical-foreground`, so a containment check passes for
    // either and cannot tell them apart. The marker is text, so it owes AA (4.5:1)
    // and must use the -foreground variant; the vivid token is for icons and fills
    // at 3:1. See theme-contrast.test.ts.
    expect(marker.props.className).toBe("text-critical-foreground");
  });

  it("does not render a required marker by default", () => {
    const el = Field({ label: "Name", children: null });
    const labelEl = el.props.children[0];
    const labelSpan = labelEl.props.children[0];
    const [, marker] = labelSpan.props.children;
    expect(marker).toBeFalsy();
  });
});
