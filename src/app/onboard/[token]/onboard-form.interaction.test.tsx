// @vitest-environment jsdom
/**
 * What a rejected onboarding submit does next.
 *
 * This contract runs to thirty-odd fields and its submit button is at the very
 * bottom, while the error summary renders above the FIRST field. A refusal used
 * to land entirely off-screen: the page did not scroll and focus stayed on the
 * button, so pressing Submit looked like it had done nothing at all. On the one
 * unauthenticated form a newly accepted volunteer reaches from an email.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const submitOnboarding = vi.fn();
vi.mock("./actions", () => ({ submitOnboarding: (...a: unknown[]) => submitOnboarding(...a) }));

const { OnboardForm } = await import("./onboard-form");
const { DIRECTOR_LAYOUT } = await import("@/modules/recruitment/contract/defaults/director");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ctx = {
  firstName: "Ada", orgName: "HAVEN Free Clinic", todayIso: "2026-07-21",
  trainingDate: "Sunday, May 3", trainingLocation: " in person",
  department: "BVHD", track: "DIRECTOR" as const, epicRequirement: "ALL" as const,
  storedEpicId: null,
};
const prefill = {
  firstName: "Ada", lastName: "L", preferredFirstName: "", email: "ada@example.com",
  netId: "abl2", phone: "203-555-0100", yaleAffiliation: "undergrad", gradYear: "2026",
};

let mounted: { container: HTMLDivElement; root: Root } | null = null;

function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<OnboardForm token="tok" prefill={prefill} layout={DIRECTOR_LAYOUT} ctx={ctx} />);
  });
  mounted = { container, root };
  return container;
}

afterEach(() => {
  if (mounted) {
    const { container, root } = mounted;
    act(() => root.unmount());
    container.remove();
    mounted = null;
  }
  submitOnboarding.mockReset();
  vi.useRealTimers();
});

/** requestAnimationFrame is what the focus move waits on. */
async function flushFrame() {
  await act(async () => {
    await new Promise((r) => requestAnimationFrame(() => r(null)));
  });
}

async function submit(c: HTMLElement) {
  const form = c.querySelector("form")!;
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await flushFrame();
}

const summary = (c: HTMLElement) => c.querySelector<HTMLElement>('[role="alert"]');

describe("a rejected onboarding submit", () => {
  it("moves focus to the summary, so the reader is taken to the refusal", async () => {
    submitOnboarding.mockResolvedValue({
      ok: false,
      message: "Some answers need another look.",
      fieldErrors: { hipaaCompletedAt: "Enter a date." },
    });
    const c = mount();
    expect(document.activeElement).toBe(document.body);
    await submit(c);
    expect(summary(c)).not.toBeNull();
    // The Alert itself carries role="alert"; focus goes to the wrapper holding it.
    expect(summary(c)!.closest('[tabindex="-1"]')).toBe(document.activeElement);
  });

  it("says how many fields need attention, which 'try again' does not", async () => {
    submitOnboarding.mockResolvedValue({
      ok: false,
      message: "Some answers need another look.",
      fieldErrors: { hipaaCompletedAt: "Enter a date.", firstName: "Required." },
    });
    const c = mount();
    await submit(c);
    expect(summary(c)!.textContent).toContain("2 fields below need attention.");
  });

  it("says it in the singular for one field", async () => {
    submitOnboarding.mockResolvedValue({
      ok: false, message: "Almost.", fieldErrors: { firstName: "Required." },
    });
    const c = mount();
    await submit(c);
    expect(summary(c)!.textContent).toContain("One field below needs attention.");
  });

  it("counts nothing when the failure is not about a field", async () => {
    submitOnboarding.mockResolvedValue({ ok: false, message: "This link has expired." });
    const c = mount();
    await submit(c);
    expect(summary(c)!.textContent).toContain("This link has expired.");
    expect(summary(c)!.textContent).not.toContain("need attention");
  });

  it("also moves focus when the action THROWS, not just when it refuses", async () => {
    // The blob/DB failure path, which sets its own retryable message.
    submitOnboarding.mockRejectedValue(new Error("blob down"));
    const c = mount();
    await submit(c);
    expect(summary(c)!.closest('[tabindex="-1"]')).toBe(document.activeElement);
    expect(summary(c)!.textContent).toContain("Something went wrong");
  });

  it("does not steal focus when the submit succeeds", async () => {
    submitOnboarding.mockResolvedValue({
      ok: true,
      nextSteps: {
        signIn: { text: null, href: null },
        training: null,
        epic: null,
        review: "A director will review your contract.",
      },
    });
    const c = mount();
    await submit(c);
    expect(summary(c)).toBeNull();
  });
});
