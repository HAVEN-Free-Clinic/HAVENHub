import { describe, expect, it } from "vitest";
import { onboardingEmail } from "./onboarding";

describe("onboardingEmail", () => {
  it("greets, names the cycle, and includes the contract link", () => {
    const { subject, html } = onboardingEmail({ firstName: "Ann", cycleTitle: "Volunteer SU26", contractUrl: "http://x/onboard/tok123" });
    expect(subject).toContain("Volunteer SU26");
    expect(html).toContain("Ann");
    expect(html).toContain("http://x/onboard/tok123");
  });
  it("escapes HTML in user values and has no em-dash", () => {
    const { subject, html } = onboardingEmail({ firstName: "<b>X</b>", cycleTitle: "A & B", contractUrl: "http://x" });
    expect(html).not.toContain("<b>X</b>");
    expect(html).toContain("&amp;");
    expect(subject).not.toContain("—");
    expect(html).not.toContain("—");
  });
  it("falls back to a neutral greeting for empty firstName", () => {
    expect(onboardingEmail({ firstName: "", cycleTitle: "C", contractUrl: "http://x" }).html).toContain("there");
  });
});
