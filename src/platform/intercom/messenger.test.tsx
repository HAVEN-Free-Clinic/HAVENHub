// @vitest-environment jsdom
/**
 * Mounts IntercomMessenger with the SDK and fetch mocked, following
 * blocker-gate.test.tsx's approach: a bare createRoot + act() mount, no
 * testing-library. Proves the two modes boot the SDK with the right
 * arguments, and that identified mode's refusal handling (401/403 -> visitor,
 * 404 -> nothing, 5xx -> keep retrying) is what every mount site (the (app)
 * layout, /apply, /login, /onboard, /get-started, /welcome) actually relies
 * on, not just the happy path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const bootIntercom = vi.fn();
const shutdown = vi.fn();
const update = vi.fn();

vi.mock("@intercom/messenger-js-sdk", () => ({
  default: (...args: unknown[]) => bootIntercom(...args),
  shutdown: (...args: unknown[]) => shutdown(...args),
  update: (...args: unknown[]) => update(...args),
}));

const { IntercomMessenger } = await import("./messenger");

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

function unmount() {
  if (!mounted) return;
  const { container, root } = mounted;
  act(() => root.unmount());
  container.remove();
  mounted = null;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  unmount();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("IntercomMessenger", () => {
  describe("visitor mode", () => {
    it("boots with just the app id -- no JWT, no user_id -- and never fetches a token", async () => {
      await mount(<IntercomMessenger appId="abc123" mode="visitor" />);
      expect(bootIntercom).toHaveBeenCalledTimes(1);
      expect(bootIntercom).toHaveBeenCalledWith({ app_id: "abc123" });
      const [args] = bootIntercom.mock.calls[0] as [Record<string, unknown>];
      expect("intercom_user_jwt" in args).toBe(false);
      expect("user_id" in args).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("shuts the session down on unmount", async () => {
      await mount(<IntercomMessenger appId="abc123" mode="visitor" />);
      unmount();
      expect(shutdown).toHaveBeenCalledTimes(1);
    });
  });

  describe("identified mode -- hub-style, no requireActiveMembership", () => {
    it("fetches the plain token endpoint and boots with the returned JWT", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { token: "jwt-1", expiresInSeconds: 3600 }));
      await mount(<IntercomMessenger appId="abc123" mode="identified" />);
      await act(async () => {});
      expect(fetchMock).toHaveBeenCalledWith("/api/support/messenger-token", { cache: "no-store" });
      expect(bootIntercom).toHaveBeenCalledWith({ app_id: "abc123", intercom_user_jwt: "jwt-1" });
    });

    it("does nothing at all on a 404 -- the integration is off, not refused", async () => {
      fetchMock.mockResolvedValue(jsonResponse(404, { error: "Not Found" }));
      await mount(<IntercomMessenger appId="abc123" mode="identified" />);
      await act(async () => {});
      expect(bootIntercom).not.toHaveBeenCalled();
    });

    it("falls back to a visitor boot on 401 (no session, or no eligible Person) before the first boot", async () => {
      fetchMock.mockResolvedValue(jsonResponse(401, { error: "Unauthorized" }));
      await mount(<IntercomMessenger appId="abc123" mode="identified" />);
      await act(async () => {});
      expect(bootIntercom).toHaveBeenCalledTimes(1);
      expect(bootIntercom).toHaveBeenCalledWith({ app_id: "abc123" });
    });

    it("does not fall back to visitor on a transient 503, so a real member is never silently anonymized by a DB blip", async () => {
      fetchMock.mockResolvedValue(jsonResponse(503, { error: "Service Unavailable" }));
      await mount(<IntercomMessenger appId="abc123" mode="identified" />);
      await act(async () => {});
      expect(bootIntercom).not.toHaveBeenCalled();
    });

    it("shuts the session down on unmount after an identified boot", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { token: "jwt-1", expiresInSeconds: 3600 }));
      await mount(<IntercomMessenger appId="abc123" mode="identified" />);
      await act(async () => {});
      unmount();
      expect(shutdown).toHaveBeenCalledTimes(1);
    });
  });

  describe("identified mode -- requireActiveMembership (the /apply portal's rule)", () => {
    it("appends requireActiveMembership=1 to the token request", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { token: "jwt-1", expiresInSeconds: 3600 }));
      await mount(<IntercomMessenger appId="abc123" mode="identified" requireActiveMembership />);
      await act(async () => {});
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/support/messenger-token?requireActiveMembership=1",
        { cache: "no-store" }
      );
    });

    it("identifies a member the route reports as having an active term membership", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { token: "member-jwt", expiresInSeconds: 3600 }));
      await mount(<IntercomMessenger appId="abc123" mode="identified" requireActiveMembership />);
      await act(async () => {});
      expect(bootIntercom).toHaveBeenCalledWith({ app_id: "abc123", intercom_user_jwt: "member-jwt" });
    });

    it("falls back to visitor when the route refuses with 403 (no active term membership), rather than failing to boot anything", async () => {
      fetchMock.mockResolvedValue(jsonResponse(403, { error: "Forbidden" }));
      await mount(<IntercomMessenger appId="abc123" mode="identified" requireActiveMembership />);
      await act(async () => {});
      expect(bootIntercom).toHaveBeenCalledTimes(1);
      expect(bootIntercom).toHaveBeenCalledWith({ app_id: "abc123" });
    });

    it("falls back to visitor when there is no session at all (a Yale-SSO applicant with no Person), the same as any other refusal", async () => {
      fetchMock.mockResolvedValue(jsonResponse(401, { error: "Unauthorized" }));
      await mount(<IntercomMessenger appId="abc123" mode="identified" requireActiveMembership />);
      await act(async () => {});
      expect(bootIntercom).toHaveBeenCalledTimes(1);
      expect(bootIntercom).toHaveBeenCalledWith({ app_id: "abc123" });
    });
  });
});
