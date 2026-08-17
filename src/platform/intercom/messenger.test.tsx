// @vitest-environment jsdom
/**
 * Mounts IntercomMessenger with the SDK and fetch mocked, following
 * blocker-gate.test.tsx's approach: a bare createRoot + act() mount, no
 * testing-library. Proves the two modes boot the SDK with the right arguments,
 * and that identified mode's refusal handling (401/403 -> visitor, 404 ->
 * nothing, 5xx -> keep retrying) is what every mount site (the (app) layout,
 * /apply, /login, /onboard, /get-started, /welcome) actually relies on, not
 * just the happy path.
 *
 * The SDK is mocked so these can assert on WHICH SDK call happens. That
 * distinction is the point of the server-minted-token cases at the bottom:
 * `update` hands over a new token without tearing down an open conversation,
 * and a second `Intercom()` re-boots the widget underneath a member who may be
 * mid-conversation. Neither throws, so only the call shape catches it.
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

// Takes a whole element rather than just an initialToken: the component has
// four props now (appId, mode, requireActiveMembership, initialToken) and the
// mode cases below need to vary more than one of them.
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
  // Restored here (not at the end of the one test that fakes timers) so a
  // failed assertion mid-test cannot leak fake timers into the rest of the
  // file. Unmount must run first: its cleanup may call the captured setTimeout
  // handle's clearTimeout while fake timers are still the active implementation.
  vi.useRealTimers();
  // React hoists these <link> tags into <head> and does not remove them on
  // unmount in jsdom, so a later test's querySelectorAll would otherwise see
  // every earlier mount's tags too.
  document.querySelectorAll('link[rel="preconnect"]').forEach((el) => el.remove());
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

  /**
   * The attributes that let a support agent see who an ANONYMOUS /apply visitor
   * signed in as (see visitor.ts). The case that actually matters in production
   * is the 403 fallback, not the explicit visitor mode: /apply mounts
   * identified and only discovers it is talking to an applicant when the token
   * route refuses. If the fallback boot stopped carrying them, every applicant
   * would go back to being nameless in the inbox and nothing else would break,
   * so only an assertion on the boot arguments catches it.
   */
  describe("visitor attributes", () => {
    const attrs = { "Portal sign-in name": "Jane Doe", "Portal sign-in email": "jane.doe@yale.edu" };

    it("attaches them to an explicit visitor boot", async () => {
      await mount(<IntercomMessenger appId="abc123" mode="visitor" visitorAttributes={attrs} />);
      expect(bootIntercom).toHaveBeenCalledWith({ app_id: "abc123", ...attrs });
    });

    it("attaches them to the 403 fallback boot -- the applicant case they exist for", async () => {
      fetchMock.mockResolvedValue(jsonResponse(403, { error: "Forbidden" }));
      await mount(
        <IntercomMessenger
          appId="abc123"
          mode="identified"
          requireActiveMembership
          visitorAttributes={attrs}
        />
      );
      await act(async () => {});
      expect(bootIntercom).toHaveBeenCalledTimes(1);
      expect(bootIntercom).toHaveBeenCalledWith({ app_id: "abc123", ...attrs });
    });

    it("attaches them to the 401 fallback boot as well", async () => {
      fetchMock.mockResolvedValue(jsonResponse(401, { error: "Unauthorized" }));
      await mount(
        <IntercomMessenger
          appId="abc123"
          mode="identified"
          requireActiveMembership
          visitorAttributes={attrs}
        />
      );
      await act(async () => {});
      expect(bootIntercom).toHaveBeenCalledWith({ app_id: "abc123", ...attrs });
    });

    it("never sends them on an identified boot, which carries the signed profile attributes instead", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { token: "member-jwt", expiresInSeconds: 3600 }));
      await mount(
        <IntercomMessenger
          appId="abc123"
          mode="identified"
          requireActiveMembership
          visitorAttributes={attrs}
        />
      );
      await act(async () => {});
      expect(bootIntercom).toHaveBeenCalledWith({ app_id: "abc123", intercom_user_jwt: "member-jwt" });
      const [args] = bootIntercom.mock.calls[0] as [Record<string, unknown>];
      expect("Portal sign-in name" in args).toBe(false);
    });

    it("leaves the boot byte-for-byte unchanged when there is nothing to send", async () => {
      await mount(<IntercomMessenger appId="abc123" mode="visitor" visitorAttributes={undefined} />);
      expect(bootIntercom).toHaveBeenCalledWith({ app_id: "abc123" });
    });

    /**
     * The prop is a fresh object on every server render. If it were named in
     * the effect's dependency array, a router.refresh() would shut the widget
     * down and re-boot it underneath an open conversation -- the same bug the
     * initialToken ref guards against, and equally silent.
     */
    it("re-rendering with an equal-but-new attributes object neither shuts down nor re-boots", async () => {
      await mount(
        <IntercomMessenger appId="abc123" mode="visitor" visitorAttributes={{ ...attrs }} />
      );
      expect(bootIntercom).toHaveBeenCalledTimes(1);

      await act(async () => {
        mounted?.root.render(
          <IntercomMessenger appId="abc123" mode="visitor" visitorAttributes={{ ...attrs }} />
        );
      });

      expect(shutdown).not.toHaveBeenCalled();
      expect(bootIntercom).toHaveBeenCalledTimes(1);
    });
  });

  describe("identified mode -- server-minted initialToken", () => {
    it("boots immediately from a server-minted token, without fetching", async () => {
      await mount(
        <IntercomMessenger
          appId="abc123"
          mode="identified"
          initialToken={{ token: "server.jwt", expiresInSeconds: 900 }}
        />
      );

      expect(bootIntercom).toHaveBeenCalledWith({
        app_id: "abc123",
        intercom_user_jwt: "server.jwt",
      });
      // The whole point of the change: no round trip on the critical path.
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("falls back to fetching when no token was server-minted", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { token: "fetched.jwt", expiresInSeconds: 900 }));

      await mount(<IntercomMessenger appId="abc123" mode="identified" initialToken={null} />);

      expect(fetchMock).toHaveBeenCalled();
      expect(bootIntercom).toHaveBeenCalledWith({
        app_id: "abc123",
        intercom_user_jwt: "fetched.jwt",
      });
    });

  /**
   * The regression this guards: booting from the prop without setting `booted`
   * makes the first refresh call Intercom() again instead of update(), which
   * re-boots the widget under a member who may be mid-conversation. Nothing
   * throws, so only asserting on which SDK function ran can catch it.
   */
    it("refreshes with update, not a second boot, after starting from the prop", async () => {
      vi.useFakeTimers();
      fetchMock.mockResolvedValue(jsonResponse(200, { token: "refreshed.jwt", expiresInSeconds: 900 }));

      await mount(
        <IntercomMessenger
          appId="abc123"
          mode="identified"
          initialToken={{ token: "server.jwt", expiresInSeconds: 900 }}
        />
      );
      expect(bootIntercom).toHaveBeenCalledTimes(1);

      // Advance past the scheduled refresh (TTL minus the 5 minute margin).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(601 * 1000);
      });

      expect(update).toHaveBeenCalledWith({ intercom_user_jwt: "refreshed.jwt" });
      expect(bootIntercom).toHaveBeenCalledTimes(1);
    });

  /**
   * The regression this guards: `mintIntercomUserJwt` calls `.setIssuedAt()`,
   * so the token STRING is different on every mint, not just its wrapper
   * object's identity. A server re-render of the (app) layout (a
   * router.refresh(), a revalidating Server Action) re-mints and hands down a
   * new string. If the effect depended on that string, React would see it
   * change, tear the effect down (cleanup calls shutdown(), killing a live
   * conversation), and rebuild it from a fresh closure with `booted` reset to
   * false, calling Intercom() again instead of update(). The fix freezes the
   * boot token in a ref so the effect has nothing to depend on but `appId`.
   */
    it("re-rendering with a different token neither shuts down nor re-boots", async () => {
      await mount(
        <IntercomMessenger
          appId="abc123"
          mode="identified"
          initialToken={{ token: "server.jwt.mint1", expiresInSeconds: 900 }}
        />
      );
      expect(bootIntercom).toHaveBeenCalledTimes(1);

      await act(async () => {
        mounted?.root.render(
          <IntercomMessenger
            appId="abc123"
            mode="identified"
            initialToken={{ token: "server.jwt.mint2", expiresInSeconds: 900 }}
          />
        );
      });

      expect(shutdown).not.toHaveBeenCalled();
      expect(bootIntercom).toHaveBeenCalledTimes(1);
      expect(update).not.toHaveBeenCalled();
    });

  /**
   * Without this, signing out (or switching accounts in the same browser)
   * leaves the previous member's support session live for the next person.
   * Deleting the shutdown() call from cleanup would leave every other case in
   * this file green, since none of them unmount and then assert.
   */
    it("calls shutdown() on unmount", async () => {
      await mount(
        <IntercomMessenger
          appId="abc123"
          mode="identified"
          initialToken={{ token: "server.jwt", expiresInSeconds: 900 }}
        />
      );
      expect(shutdown).not.toHaveBeenCalled();

      unmount();

      expect(shutdown).toHaveBeenCalledTimes(1);
    });
  });

  // Rendered by the component in BOTH modes, so this asserts against a visitor
  // mount: /login is the surface where they matter most, having no session work
  // to overlap the handshake with.
  it("renders preconnect hints for the Intercom hosts, including in visitor mode", async () => {
    await mount(<IntercomMessenger appId="abc123" mode="visitor" />);
    const hrefs = Array.from(document.querySelectorAll('link[rel="preconnect"]')).map((l) =>
      l.getAttribute("href")
    );
    expect(hrefs).toContain("https://widget.intercom.io");
    expect(hrefs).toContain("https://js.intercomcdn.com");
  });
});
