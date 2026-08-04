import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { OnboardingTask } from "@/modules/onboarding/services/onboarding";

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
