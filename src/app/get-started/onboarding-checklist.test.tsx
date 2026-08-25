import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { OnboardingTask } from "@/modules/onboarding/services/onboarding";
import type { MyEhsItem } from "@/platform/ehs/services/my-ehs";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { OnboardingChecklist } = await import("./onboarding-checklist");

const learning = (over: Partial<OnboardingTask> = {}): OnboardingTask => ({
  key: "learning",
  label: "Learning modules",
  description: "Complete the courses your department assigned to you.",
  href: "/get-started/learning",
  ctaLabel: "Open courses",
  reviewable: true,
  state: "COMPLETE",
  blocking: true,
  ...over,
});

const ehsTask = (over: Partial<OnboardingTask> = {}): OnboardingTask => ({
  key: "ehs",
  label: "EHS training",
  description: "Recorded by your coordinator once you complete them.",
  href: undefined,
  ctaLabel: undefined,
  state: "INCOMPLETE",
  blocking: false,
  ...over,
});

const ehsItem = (over: Partial<MyEhsItem> = {}): MyEhsItem => ({
  id: "ehs_bbp_student",
  name: "BBP Student",
  description: null,
  complete: false,
  completedAt: null,
  completionUrl: "https://www.myworkday.com/yale/learning",
  ...over,
});

describe("OnboardingChecklist EHS tile", () => {
  it("names each outstanding item and links it to the system that owns it", () => {
    // The reason this exists: EHS held BBP open for a missing HepB assessment while
    // the tile showed one unlabelled "Complete in Workday" button, so a member could
    // not tell what was outstanding OR that it lives in HealthOnTrack, not Workday.
    const out = renderToStaticMarkup(
      <OnboardingChecklist
        tasks={[ehsTask()]}
        ehsItems={[
          ehsItem(),
          ehsItem({
            id: "ehs_hepb_immunity",
            name: "HepB Immunity Assessment",
            description: "Part of the Bloodborne Pathogens (BBP) requirement.",
            completionUrl:
              "https://healthontrack.yale.edu/s/chs-health-requirement/CHS_Health_Requirement__c/",
          }),
        ]}
      />
    );
    expect(out).toContain("HepB Immunity Assessment");
    expect(out).toContain("Part of the Bloodborne Pathogens (BBP) requirement.");
    expect(out).toContain("Complete in HealthOnTrack");
    expect(out).toContain("Complete in Workday");
    expect(out).toContain("Action needed");
  });

  it("omits items already recorded complete", () => {
    const out = renderToStaticMarkup(
      <OnboardingChecklist
        tasks={[ehsTask()]}
        ehsItems={[ehsItem({ complete: true }), ehsItem({ id: "ehs_tb_baseline", name: "TB Baseline Screening" })]}
      />
    );
    expect(out).not.toContain("BBP Student");
    expect(out).toContain("TB Baseline Screening");
  });

  it("reads as Pending, not Action needed, when there is nothing the member can act on", () => {
    const out = renderToStaticMarkup(<OnboardingChecklist tasks={[ehsTask()]} ehsItems={[]} />);
    expect(out).toContain("Pending");
    expect(out).not.toContain("Action needed");
  });

  it("lists a coordinator-recorded item but does not call the tile actionable", () => {
    // "Added to EHS?" outstanding on its own: worth SEEING, but there is no
    // Workday page that completes it, so no link and no "Action needed" nag.
    const out = renderToStaticMarkup(
      <OnboardingChecklist
        tasks={[ehsTask()]}
        ehsItems={[ehsItem({ id: "ehs_added_to_ehs", name: "Added to EHS?", completionUrl: null })]}
      />
    );
    expect(out).toContain("Added to EHS?");
    expect(out).toContain("Pending");
    expect(out).not.toContain("Complete in");
  });
});

describe("OnboardingChecklist", () => {
  it("offers a Review link for a completed reviewable task", () => {
    const out = renderToStaticMarkup(<OnboardingChecklist tasks={[learning()]} />);
    expect(out).toContain('href="/get-started/learning"');
    expect(out).toContain("Review");
  });

  it("does not offer Review for a completed task that is not reviewable", () => {
    const out = renderToStaticMarkup(
      <OnboardingChecklist
        tasks={[
          learning({
            key: "hipaa",
            label: "HIPAA certificate",
            href: "/get-started/hipaa",
            ctaLabel: "Upload certificate",
            reviewable: undefined,
          }),
        ]}
      />
    );
    expect(out).not.toContain("Review");
    expect(out).not.toContain('href="/get-started/hipaa"');
  });

  it("does not offer Review for a NOT_REQUIRED task, whose page redirects away", () => {
    const out = renderToStaticMarkup(
      <OnboardingChecklist tasks={[learning({ state: "NOT_REQUIRED" })]} />
    );
    expect(out).toContain("Not required");
    expect(out).not.toContain("Review");
  });

  it("still shows the primary CTA while the task is incomplete", () => {
    const out = renderToStaticMarkup(
      <OnboardingChecklist tasks={[learning({ state: "INCOMPLETE" })]} />
    );
    expect(out).toContain("Open courses");
    expect(out).not.toContain("Review");
  });
});
