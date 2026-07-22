import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OnboardingPreviewBody, type OnboardingPreviewContext } from "./onboarding-preview";
import type { ContractLayout } from "@/modules/recruitment/contract/layout";

const base: OnboardingPreviewContext = {
  departments: [
    { code: "IM", name: "Internal Medicine", requiresEpicDirector: "ALL", requiresEpicVolunteer: "SOME" },
    { code: "PEDS", name: "Pediatrics", requiresEpicDirector: "NONE", requiresEpicVolunteer: "NONE" },
  ],
  orgName: "HAVEN Free Clinic",
  trainingDate: "Sunday, May 3",
  trainingLocation: " in person",
  todayIso: "2026-07-22",
  title: "Fall 2026",
  fixedTrack: "VOLUNTEER",
};

const render = (layout: ContractLayout, ctx: Partial<OnboardingPreviewContext> = {}) =>
  renderToStaticMarkup(<OnboardingPreviewBody {...base} {...ctx} layout={layout} />);

describe("OnboardingPreviewBody", () => {
  it("renders the department picker and a read-only track chip in cycle mode", () => {
    const out = render({ blocks: [] });
    expect(out).toContain("Internal Medicine");
    expect(out).toContain("Pediatrics");
    expect(out).toContain("Volunteer"); // fixed-track chip
    expect(out).not.toContain('value="DIRECTOR"'); // no toggle button in cycle mode
  });

  it("renders a track toggle when there is no fixed track (global mode)", () => {
    const out = render({ blocks: [] }, { fixedTrack: null });
    expect(out).toContain("Director");
    expect(out).toContain("Volunteer");
  });

  it("shows a block gated to the first (default-selected) department", () => {
    const layout: ContractLayout = {
      blocks: [
        { kind: "agreement", id: "im_duties", title: "IM duties", body: "", signatureLabel: "I agree",
          confirmKind: "checkbox", visibleWhen: { field: "department", op: "is", value: "IM" } },
        { kind: "agreement", id: "peds_duties", title: "PEDS duties", body: "", signatureLabel: "I agree",
          confirmKind: "checkbox", visibleWhen: { field: "department", op: "is", value: "PEDS" } },
      ],
    };
    const out = render(layout);
    expect(out).toContain("IM duties"); // IM is departments[0], selected by default
    expect(out).not.toContain("PEDS duties");
  });

  it("does not render a submit control", () => {
    const out = render({ blocks: [{ kind: "system_field", systemKey: "email" }] });
    expect(out).not.toContain('type="submit"');
  });
});
