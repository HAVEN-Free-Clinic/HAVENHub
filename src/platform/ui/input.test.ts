import { describe, expect, it } from "vitest";
import { ReadonlyField } from "./input";

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
