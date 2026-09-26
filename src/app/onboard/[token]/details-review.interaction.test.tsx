// @vitest-environment jsdom
/**
 * A submit the browser refuses over a control inside the collapsed summary.
 *
 * `required` on a control inside the `hidden` wrapper is one the browser refuses
 * to submit AND cannot focus, so "Submit onboarding" silently did nothing (#910).
 * #910 stopped rendering that shape; this net recovers if it ever comes back:
 * the wrapper opens, the refused control takes focus, and the refusal is
 * recorded, instead of a dead button and no telemetry at all.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SystemFieldBlock } from "@/modules/recruitment/contract/layout";

const capture = vi.fn();
vi.mock("posthog-js", () => ({ default: { capture: (...a: unknown[]) => capture(...a) } }));

const { DetailsReview } = await import("./details-review");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const prefill = {
  firstName: "Ada", legalMiddleName: "", lastName: "Lovelace", preferredFirstName: "",
  email: "ada@yale.edu", netId: "al99", phone: "", pronouns: "",
  yaleAffiliation: "staff", gradYear: "",
};
const blocks: SystemFieldBlock[] = [
  { kind: "system_field", systemKey: "email" },
  // Required and blank, so it is asked as a visible field below the summary.
  { kind: "system_field", systemKey: "phone", required: true },
];
/** Every input is `required`, so the summarized email input is exactly the
 *  shape that dead-ended the submit: required, inside the hidden wrapper. */
const renderField = (b: SystemFieldBlock) => <input key={b.systemKey} name={b.systemKey} required />;

let mounted: { container: HTMLDivElement; root: Root } | null = null;

function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<DetailsReview blocks={blocks} prefill={prefill} err={() => undefined} renderField={renderField} />);
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
  capture.mockReset();
});

function fireInvalid(control: Element) {
  const event = new Event("invalid", { cancelable: true });
  act(() => {
    control.dispatchEvent(event);
  });
  return event;
}

describe("a submit refused over a hidden summarized control", () => {
  it("opens the summary, focuses the refused control, and records it", () => {
    const c = mount();
    const email = c.querySelector<HTMLInputElement>('input[name="email"]')!;
    expect(email.closest("[hidden]")).not.toBeNull();

    const event = fireInvalid(email);

    expect(event.defaultPrevented).toBe(true);
    expect(email.closest("[hidden]")).toBeNull();
    expect(document.activeElement).toBe(email);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith("onboarding_submit_blocked", { field: "email", hidden: true });
  });

  it("leaves a refusal on a visible field to the browser", () => {
    const c = mount();
    const phone = c.querySelector<HTMLInputElement>('input[name="phone"]')!;
    expect(phone.closest("[hidden]")).toBeNull();

    const event = fireInvalid(phone);

    expect(event.defaultPrevented).toBe(false);
    expect(capture).not.toHaveBeenCalled();
    expect(c.querySelector('input[name="email"]')!.closest("[hidden]")).not.toBeNull();
  });
});
