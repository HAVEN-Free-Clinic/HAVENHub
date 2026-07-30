import { describe, it, expect } from "vitest";
import { buildOnboardingNextSteps } from "./onboarding-next-steps";

const BASE = {
  email: "volunteer@yale.edu",
  trainingDate: "Saturday, September 12",
  trainingLocation: " 55 Church Street",
  epicRequirement: "NONE" as const,
  storedEpicId: null,
  hasEpic: false,
};

describe("buildOnboardingNextSteps", () => {
  it("gives the SSO line for a yale.edu address", () => {
    const steps = buildOnboardingNextSteps({ ...BASE, email: "j.doe@yale.edu" });
    expect(steps.signIn.method).toBe("sso");
    expect(steps.signIn.text).toBe("Sign in with your Yale NetID.");
  });

  it("is case- and whitespace-insensitive when detecting a yale.edu address", () => {
    const steps = buildOnboardingNextSteps({ ...BASE, email: "  J.Doe@YALE.EDU  " });
    expect(steps.signIn.method).toBe("sso");
  });

  it("gives the emailed-link line for a non-yale address", () => {
    const steps = buildOnboardingNextSteps({ ...BASE, email: "volunteer@gmail.com" });
    expect(steps.signIn.method).toBe("magic-link");
    expect(steps.signIn.text).toBe(
      "Enter your email on the sign-in page and we will email you a one-time sign-in link.",
    );
  });

  it("does not mistake a lookalike domain (yale.edu.evil.com) for a real Yale address", () => {
    const steps = buildOnboardingNextSteps({ ...BASE, email: "attacker@yale.edu.evil.com" });
    expect(steps.signIn.method).toBe("magic-link");
  });

  it("produces sensible content for a cycle with no training date and no location", () => {
    const steps = buildOnboardingNextSteps({
      ...BASE,
      trainingDate: "the scheduled training date",
      trainingLocation: "",
    });
    expect(steps.training).toBe("Plan to attend in-person training on the scheduled training date.");
  });

  it("includes the location when one is set", () => {
    const steps = buildOnboardingNextSteps({
      ...BASE,
      trainingDate: "Saturday, September 12",
      trainingLocation: " 55 Church Street",
    });
    expect(steps.training).toBe("Plan to attend in-person training on Saturday, September 12 55 Church Street.");
  });

  it("says nothing about Epic when the department has no requirement and no Epic ID is on file", () => {
    const steps = buildOnboardingNextSteps({ ...BASE, epicRequirement: "NONE", storedEpicId: null, hasEpic: false });
    expect(steps.epic).toBeNull();
  });

  it("confirms the stored Epic ID needs no action, even for an ALL department", () => {
    const steps = buildOnboardingNextSteps({
      ...BASE,
      epicRequirement: "ALL",
      storedEpicId: "JDOE1",
      hasEpic: false,
    });
    expect(steps.epic).toBe("Your Epic ID is already on file, so there is nothing more to do for Epic access.");
  });

  it("promises IT will set up a new Epic account when the department requires it and none is on file", () => {
    const steps = buildOnboardingNextSteps({
      ...BASE,
      epicRequirement: "ALL",
      storedEpicId: null,
      hasEpic: false,
    });
    expect(steps.epic).toBe("The IT team will set up your Epic account and email you sign-in instructions once it is ready.");
  });

  it("promises IT will update the existing account when the applicant self-reported having one", () => {
    const steps = buildOnboardingNextSteps({
      ...BASE,
      epicRequirement: "SOME",
      storedEpicId: null,
      hasEpic: true,
    });
    expect(steps.epic).toBe("The IT team will update your existing Epic account and email you once it is ready.");
  });

  it("stored Epic ID takes precedence over a self-reported answer", () => {
    const steps = buildOnboardingNextSteps({
      ...BASE,
      epicRequirement: "SOME",
      storedEpicId: "JDOE1",
      hasEpic: true,
    });
    expect(steps.epic).toBe("Your Epic ID is already on file, so there is nothing more to do for Epic access.");
  });

  it("always states a director-side next step", () => {
    const steps = buildOnboardingNextSteps(BASE);
    expect(steps.review).toBe("A recruitment lead will review your submission and add you to the roster.");
  });

  it("always returns the sign-in path", () => {
    const steps = buildOnboardingNextSteps(BASE);
    expect(steps.loginPath).toBe("/login");
  });
});
