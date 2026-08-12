// @vitest-environment jsdom
/**
 * The SDK is mocked so these assert on WHICH SDK call happens. That distinction
 * is the point: `update` hands over a new token without tearing down an open
 * conversation, and a second `Intercom()` re-boots the widget underneath a
 * member who may be mid-conversation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sdk = vi.hoisted(() => ({ boot: vi.fn(), update: vi.fn(), shutdown: vi.fn() }));
vi.mock("@intercom/messenger-js-sdk", () => ({
  default: sdk.boot,
  update: sdk.update,
  shutdown: sdk.shutdown,
}));

import { IntercomMessenger } from "./messenger";

let mounted: { container: HTMLDivElement; root: Root } | null = null;

async function mount(initialToken?: { token: string; expiresInSeconds: number } | null) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<IntercomMessenger appId="abc123" initialToken={initialToken} />);
  });
  mounted = { container, root };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  if (mounted) {
    const { container, root } = mounted;
    act(() => root.unmount());
    container.remove();
    mounted = null;
  }
  vi.unstubAllGlobals();
});

describe("IntercomMessenger", () => {
  it("boots immediately from a server-minted token, without fetching", async () => {
    await mount({ token: "server.jwt", expiresInSeconds: 900 });

    expect(sdk.boot).toHaveBeenCalledWith({ app_id: "abc123", intercom_user_jwt: "server.jwt" });
    // The whole point of the change: no round trip on the critical path.
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("falls back to fetching when no token was server-minted", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ token: "fetched.jwt", expiresInSeconds: 900 }),
    });

    await mount(null);

    expect(globalThis.fetch).toHaveBeenCalled();
    expect(sdk.boot).toHaveBeenCalledWith({ app_id: "abc123", intercom_user_jwt: "fetched.jwt" });
  });

  /**
   * The regression this guards: booting from the prop without setting `booted`
   * makes the first refresh call Intercom() again instead of update(), which
   * re-boots the widget under a member who may be mid-conversation. Nothing
   * throws, so only asserting on which SDK function ran can catch it.
   */
  it("refreshes with update, not a second boot, after starting from the prop", async () => {
    vi.useFakeTimers();
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ token: "refreshed.jwt", expiresInSeconds: 900 }),
    });

    await mount({ token: "server.jwt", expiresInSeconds: 900 });
    expect(sdk.boot).toHaveBeenCalledTimes(1);

    // Advance past the scheduled refresh (TTL minus the 5 minute margin).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(601 * 1000);
    });

    expect(sdk.update).toHaveBeenCalledWith({ intercom_user_jwt: "refreshed.jwt" });
    expect(sdk.boot).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("renders preconnect hints for the Intercom hosts", async () => {
    await mount({ token: "server.jwt", expiresInSeconds: 900 });
    const hrefs = Array.from(document.querySelectorAll('link[rel="preconnect"]')).map((l) =>
      l.getAttribute("href")
    );
    expect(hrefs).toContain("https://widget.intercom.io");
    expect(hrefs).toContain("https://js.intercomcdn.com");
  });
});
