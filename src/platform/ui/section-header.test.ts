import { describe, expect, it } from "vitest";
import { SectionHeader } from "./section-header";

describe("SectionHeader", () => {
  it("defaults to the uppercase muted eyebrow on an h2", () => {
    const el = SectionHeader({ children: "Profile" });
    expect(el.type).toBe("h2");
    expect(el.props.className).toContain("uppercase");
    expect(el.props.className).toContain("tracking-wider");
    expect(el.props.className).toContain("text-muted-foreground");
    expect(el.props.children).toBe("Profile");
  });

  it("renders the non-uppercase title level", () => {
    const el = SectionHeader({ level: "title", children: "Assignment" });
    expect(el.props.className).toContain("text-base");
    expect(el.props.className).toContain("font-semibold");
    expect(el.props.className).toContain("text-foreground");
    expect(el.props.className).not.toContain("uppercase");
  });

  it("merges a caller className for margin", () => {
    const el = SectionHeader({ className: "mb-4", children: "X" });
    expect(el.props.className).toContain("mb-4");
  });

  it("renders as an h3 when as='h3', keeping the level styling", () => {
    const el = SectionHeader({ as: "h3", children: "Subsection" });
    expect(el.type).toBe("h3");
    expect(el.props.className).toContain("uppercase");
    expect(el.props.children).toBe("Subsection");
  });
});
