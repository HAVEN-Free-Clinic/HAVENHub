// @vitest-environment jsdom
/**
 * Mounts the link with the SDK and the readiness store mocked, following
 * messenger-actions.test.tsx's approach: a bare createRoot + act() mount, no
 * testing-library.
 *
 * Every assertion here is about ONE question -- does this click reach Intercom
 * or the mail client -- so they check both halves of it: the SDK call, and
 * whether the anchor's default (the mailto navigation) survived. Checking only
 * the SDK call would pass a version that opens the Messenger AND fires the
 * mailto, which is the bug a user would actually notice.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { MessengerReadiness } from "./messenger-readiness";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const showNewMessage = vi.fn();

vi.mock("@intercom/messenger-js-sdk", () => ({
  showNewMessage: (...args: unknown[]) => showNewMessage(...args),
}));

let readiness: MessengerReadiness = "pending";

vi.mock("./messenger-readiness", () => ({
  useMessengerReadiness: () => readiness,
}));

const { MessengerSupportLink } = await import("./messenger-support-link");

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

/**
 * Dispatches a real, cancelable click and reports whether the mailto navigation
 * survived it. `init` covers the modified clicks that must always belong to the
 * browser.
 *
 * The document-level listener is not incidental. It runs after the component's
 * own handler has bubbled, records the verdict, and only then cancels the
 * event, so jsdom does not go on to attempt the mailto navigation it cannot
 * perform and log "Not implemented: navigation to another Document" over every
 * fall-back assertion in this file. Reading `event.defaultPrevented` after
 * dispatch instead would be equivalent, minus the quiet output.
 */
async function clickPreventsDefault(anchor: HTMLAnchorElement, init: MouseEventInit = {}) {
  let prevented = false;
  function record(event: Event) {
    prevented = event.defaultPrevented;
    event.preventDefault();
  }
  document.addEventListener("click", record);
  try {
    await act(async () => {
      anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
    });
  } finally {
    document.removeEventListener("click", record);
  }
  return prevented;
}

afterEach(() => {
  if (mounted) {
    const { container, root } = mounted;
    act(() => root.unmount());
    container.remove();
    mounted = null;
  }
  readiness = "pending";
  showNewMessage.mockClear();
});

describe("MessengerSupportLink", () => {
  it("opens a fresh Messenger composer instead of the mail client once the widget is up", async () => {
    readiness = "ready";
    const container = await mount(
      <MessengerSupportLink email="it@example.org">Contact the IT team</MessengerSupportLink>,
    );
    const anchor = container.querySelector("a")!;

    expect(await clickPreventsDefault(anchor)).toBe(true);
    expect(showNewMessage).toHaveBeenCalledWith("");
  });

  it("falls back to the mailto when the widget is unreachable", async () => {
    readiness = "unreachable";
    const container = await mount(
      <MessengerSupportLink email="it@example.org">Contact the IT team</MessengerSupportLink>,
    );
    const anchor = container.querySelector("a")!;

    expect(await clickPreventsDefault(anchor)).toBe(false);
    expect(showNewMessage).not.toHaveBeenCalled();
  });

  it("falls back to the mailto while the widget is still loading", async () => {
    // "pending" is not a maybe: a click that queued against a widget which may
    // never arrive is the dead control this component exists to avoid.
    readiness = "pending";
    const container = await mount(
      <MessengerSupportLink email="it@example.org">Contact the IT team</MessengerSupportLink>,
    );
    const anchor = container.querySelector("a")!;

    expect(await clickPreventsDefault(anchor)).toBe(false);
    expect(showNewMessage).not.toHaveBeenCalled();
  });

  it("always carries the mailto href, so the enhancement is never the only path", async () => {
    readiness = "ready";
    const container = await mount(
      <MessengerSupportLink email="it@example.org">Contact the IT team</MessengerSupportLink>,
    );

    expect(container.querySelector("a")!.getAttribute("href")).toBe("mailto:it@example.org");
  });

  it("leaves modified clicks to the browser even when the Messenger is up", async () => {
    readiness = "ready";
    const container = await mount(
      <MessengerSupportLink email="it@example.org">Contact the IT team</MessengerSupportLink>,
    );
    const anchor = container.querySelector("a")!;

    for (const modifier of ["metaKey", "ctrlKey", "shiftKey", "altKey"] as const) {
      expect(await clickPreventsDefault(anchor, { [modifier]: true })).toBe(false);
    }

    expect(showNewMessage).not.toHaveBeenCalled();
  });

  it("renders plain text with no support email, same as SupportLink", async () => {
    readiness = "ready";
    const container = await mount(
      <MessengerSupportLink email="">Contact the IT team</MessengerSupportLink>,
    );

    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toBe("Contact the IT team");
  });
});
