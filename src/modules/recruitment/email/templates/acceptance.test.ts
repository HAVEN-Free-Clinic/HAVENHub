import { describe, expect, it } from "vitest";
import { acceptanceEmail } from "./acceptance";

describe("acceptanceEmail", () => {
  it("greets by first name and names the department", () => {
    const { subject, html } = acceptanceEmail({ firstName: "Ann", cycleTitle: "Volunteer SU26", departmentName: "Student Run Health Department" });
    expect(subject).toContain("Student Run Health Department");
    expect(html).toContain("Ann");
    expect(html).toContain("Student Run Health Department");
    expect(html).toContain("Volunteer SU26");
  });
  it("escapes HTML in user-supplied values", () => {
    const { html } = acceptanceEmail({ firstName: "<script>x</script>", cycleTitle: "C", departmentName: "D & E" });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&amp;");
  });
  it("falls back to a neutral greeting when first name is empty", () => {
    const { html } = acceptanceEmail({ firstName: "", cycleTitle: "C", departmentName: "D" });
    expect(html).toContain("there");
  });
});
