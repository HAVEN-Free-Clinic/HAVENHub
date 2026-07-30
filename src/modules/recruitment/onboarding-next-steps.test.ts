import { describe, it, expect } from "vitest";
import { buildOnboardingNextSteps } from "./onboarding-next-steps";

const BASE = {
  email: "volunteer@yale.edu",
  trainingDate: "Saturday, September 12",
  trainingLocation: " 55 Church Street",
  epicNeeded: false,
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

  it("says nothing about Epic when no request will ever be created (epicNeeded false, no stored ID, no self-reported existing account)", () => {
    const steps = buildOnboardingNextSteps({ ...BASE, epicNeeded: false, storedEpicId: null, hasEpic: false });
    expect(steps.epic).toBeNull();
  });

  // The exact regression this content shipped with: a SOME department (e.g.
  // SRHD, requiresEpicVolunteer: "SOME") plus a self-reported "no" answer
  // makes resolveEpicNeeded return false (epic-requirement.ts), so
  // promoteContracts never creates an EpicRequest (promotion.ts's
  // `contract.epicNeeded && !effectiveEpicId` gate). Gating this copy on the
  // raw epicRequirement enum instead of the resolved epicNeeded boolean would
  // promise an IT follow-up email that never comes. epicNeeded is what must
  // gate this branch, not epicRequirement -- this input type has no
  // epicRequirement field at all, only the resolved boolean.
  it("promises nothing for a SOME-department applicant who self-reported not needing Epic", () => {
    const steps = buildOnboardingNextSteps({ ...BASE, epicNeeded: false, storedEpicId: null, hasEpic: false });
    expect(steps.epic).toBeNull();
  });

  it("confirms the stored Epic ID needs no action, even when epicNeeded is true", () => {
    const steps = buildOnboardingNextSteps({
      ...BASE,
      epicNeeded: true,
      storedEpicId: "JDOE1",
      hasEpic: false,
    });
    expect(steps.epic).toBe("Your Epic ID is already on file, so there is nothing more to do for Epic access.");
  });

  it("promises IT will set up a new Epic account when epicNeeded is true and no ID is on file or self-reported", () => {
    const steps = buildOnboardingNextSteps({
      ...BASE,
      epicNeeded: true,
      storedEpicId: null,
      hasEpic: false,
    });
    expect(steps.epic).toBe("The IT team will set up your Epic account and email you sign-in instructions once it is ready.");
  });

  // promotion.ts's effectiveEpicId is `person.epicId ?? contract.existingEpicId`,
  // so a self-reported existing ID is adopted directly and no EpicRequest (and
  // so no IT follow-up email) is ever created for it, regardless of epicNeeded.
  it("says the provided Epic ID will be added, not that IT will follow up, when the applicant self-reported an existing account", () => {
    const steps = buildOnboardingNextSteps({
      ...BASE,
      epicNeeded: true,
      storedEpicId: null,
      hasEpic: true,
    });
    expect(steps.epic).toBe("The Epic ID you provided will be added to your account, so there is nothing more to do for Epic access right now.");
  });

  it("stored Epic ID takes precedence over a self-reported existing account", () => {
    const steps = buildOnboardingNextSteps({
      ...BASE,
      epicNeeded: true,
      storedEpicId: "JDOE1",
      hasEpic: true,
    });
    expect(steps.epic).toBe("Your Epic ID is already on file, so there is nothing more to do for Epic access.");
  });

  it("always states a director-side next step", () => {
    const steps = buildOnboardingNextSteps(BASE);
    expect(steps.review).toBe("A recruitment lead will review your submission and add you to the roster.");
  });

  it("defaults the review line to future tense when reviewed is omitted", () => {
    const steps = buildOnboardingNextSteps(BASE);
    expect(steps.review).toBe("A recruitment lead will review your submission and add you to the roster.");
  });

  it("keeps the review line in future tense when reviewed is explicitly false", () => {
    const steps = buildOnboardingNextSteps({ ...BASE, reviewed: false });
    expect(steps.review).toBe("A recruitment lead will review your submission and add you to the roster.");
  });

  // PROMOTED contracts pass reviewed: true (onboard/[token]/page.tsx), because
  // promoteContracts IS the review-and-roster-add action (promotion.ts:191-213).
  // Telling an already-accepted, already-scheduled volunteer that a lead
  // "will" still review them is the exact confusion this content module
  // exists to remove, so the past-tense variant must be a real, distinct string.
  it("switches the review line to past tense when reviewed is true", () => {
    const steps = buildOnboardingNextSteps({ ...BASE, reviewed: true });
    expect(steps.review).toBe("A recruitment lead has reviewed your submission and added you to the roster.");
  });

  it("always returns the sign-in path", () => {
    const steps = buildOnboardingNextSteps(BASE);
    expect(steps.loginPath).toBe("/login");
  });
});
