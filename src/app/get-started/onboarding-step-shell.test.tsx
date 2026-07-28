import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { OnboardingStepShell } = await import("./onboarding-step-shell");

describe("OnboardingStepShell", () => {
  it("defaults the back link to the checklist", () => {
    const out = renderToStaticMarkup(
      <OnboardingStepShell title="HIPAA certificate" completedCount={1} totalCount={4}>
        <p>body</p>
      </OnboardingStepShell>
    );
    expect(out).toContain('href="/get-started"');
    expect(out).toContain("Back to checklist");
  });

  it("uses the supplied back link and label", () => {
    const out = renderToStaticMarkup(
      <OnboardingStepShell
        title="Bloodborne Pathogens"
        completedCount={2}
        totalCount={4}
        backHref="/get-started/learning"
        backLabel="Back to courses"
      >
        <p>body</p>
      </OnboardingStepShell>
    );
    expect(out).toContain('href="/get-started/learning"');
    expect(out).toContain("Back to courses");
    expect(out).not.toContain("Back to checklist");
  });

  it("keeps the narrow container by default and widens when asked", () => {
    const narrow = renderToStaticMarkup(
      <OnboardingStepShell title="Profile" completedCount={0} totalCount={4}>
        <p>body</p>
      </OnboardingStepShell>
    );
    expect(narrow).toContain("max-w-3xl");
    expect(narrow).not.toContain("max-w-6xl");

    const wide = renderToStaticMarkup(
      <OnboardingStepShell title="Course" completedCount={0} totalCount={4} wide>
        <p>body</p>
      </OnboardingStepShell>
    );
    expect(wide).toContain("max-w-6xl");
    expect(wide).not.toContain("max-w-3xl");
  });

  it("renders the progress chip and the title", () => {
    const out = renderToStaticMarkup(
      <OnboardingStepShell title="Learning modules" completedCount={2} totalCount={5}>
        <p>body</p>
      </OnboardingStepShell>
    );
    expect(out).toContain("2 of 5 complete");
    expect(out).toContain("Learning modules");
  });
});
