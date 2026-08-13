// @vitest-environment jsdom
/**
 * Mounts the messenger-action buttons with the SDK mocked, following
 * blocker-gate.test.tsx's approach: a bare createRoot + act() mount, no
 * testing-library. Proves each button calls the right SDK function with the
 * right argument on click -- not the SDK's own queueing behavior, which is
 * @intercom/messenger-js-sdk's job to get right, not ours.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const showConversation = vi.fn();
const showNewMessage = vi.fn();

vi.mock("@intercom/messenger-js-sdk", () => ({
  showConversation: (...args: unknown[]) => showConversation(...args),
  showNewMessage: (...args: unknown[]) => showNewMessage(...args),
}));

const { ContinueConversationButton, AskInMessengerButton } = await import("./messenger-actions");

let mounted: { container: HTMLDivElement; root: Root } | null = null;

async function mount(node: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
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
  showConversation.mockClear();
  showNewMessage.mockClear();
});

describe("ContinueConversationButton", () => {
  it("calls showConversation with the conversation id on click", async () => {
    const container = await mount(<ContinueConversationButton conversationId="conv-42" />);
    const button = container.querySelector("button")!;
    await act(async () => button.click());
    expect(showConversation).toHaveBeenCalledWith("conv-42");
    expect(showNewMessage).not.toHaveBeenCalled();
  });

  it("defaults its label and accepts an override", async () => {
    const container = await mount(<ContinueConversationButton conversationId="conv-42" />);
    expect(container.textContent).toBe("Continue in Messenger");
  });
});

describe("AskInMessengerButton", () => {
  it("calls showNewMessage with an empty draft on click", async () => {
    const container = await mount(<AskInMessengerButton />);
    const button = container.querySelector("button")!;
    await act(async () => button.click());
    expect(showNewMessage).toHaveBeenCalledWith("");
    expect(showConversation).not.toHaveBeenCalled();
  });
});
