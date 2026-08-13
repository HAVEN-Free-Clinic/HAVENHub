/**
 * Wiring test for the (app) group layout: which Messenger-related client
 * components it mounts, under what conditions, and with which props.
 *
 * Two things are proved here that nothing else can prove.
 *
 * The first is the gate's scoping. IntercomMessenger and BlockerGate are
 * compared by the actual imported function reference, not by name, so a rename
 * or re-export still gets caught. This is the positive half of the requirement;
 * see apply/layout.test.tsx and login/layout.test.tsx for the negative half (a
 * public surface that mounts the Messenger but never BlockerGate).
 *
 * The second is that mintMessengerTokenForSession's blast radius is contained
 * at this layout's Promise.all. That function converts only a recognized
 * DB-unreachable shape into a clean refusal; everything else (an unrecognized
 * DB error, a jose failure, a bug in getEffectivePermissions) rethrows --
 * correct for its original caller, the token route, where an unhandled
 * rejection is a contained 500 on /api/support/messenger-token alone. This
 * layout is its second caller, and an unhandled rejection inside Promise.all
 * here would reject the ENTIRE authenticated hub for every signed-in member
 * over what should be a support-only failure.
 *
 * Real element tree, no renderer: AppGroupLayout is an async Server Component,
 * so calling it directly and walking the returned React elements (plain
 * {type, props} objects) proves both that the promise settles and what
 * IntercomMessenger actually receives, without needing jsdom. AppShell,
 * PostHogIdentify and BlockerGate are stubbed only so their own heavy import
 * chains do not have to be dragged in; building an element tree without a
 * renderer never calls the referenced component functions either way.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requirePersonSession: vi.fn(),
  getActiveTerm: vi.fn(),
  reviewScope: vi.fn(),
  isInterviewPanelist: vi.fn(),
  getSupportContact: vi.fn(),
  getSetting: vi.fn(),
  mintMessengerTokenForSession: vi.fn(),
  resolveSupportAppId: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@/platform/auth/session", () => ({
  requirePersonSession: mocks.requirePersonSession,
}));
vi.mock("@/platform/terms/active-term", () => ({ getActiveTerm: mocks.getActiveTerm }));
vi.mock("@/modules/recruitment/services/review", () => ({ reviewScope: mocks.reviewScope }));
vi.mock("@/modules/recruitment/services/interviews", () => ({
  isInterviewPanelist: mocks.isInterviewPanelist,
}));
vi.mock("@/platform/branding/support", () => ({ getSupportContact: mocks.getSupportContact }));
vi.mock("@/platform/settings/service", () => ({ getSetting: mocks.getSetting }));
vi.mock("@/modules/support/services/messenger-token", () => ({
  mintMessengerTokenForSession: mocks.mintMessengerTokenForSession,
}));
vi.mock("@/platform/intercom/config", () => ({
  resolveSupportAppId: mocks.resolveSupportAppId,
}));
vi.mock("@/platform/logging", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: mocks.logError },
  errorAttrs: (err: unknown) => ({ "error.message": String(err) }),
}));
// Stubbed so importing this test file does not drag in their own (unrelated,
// heavy) import chains. They are never invoked either way.
vi.mock("@/platform/ui/app-shell", () => ({ AppShell: () => null }));
vi.mock("@/platform/posthog/posthog-identify", () => ({ PostHogIdentify: () => null }));
vi.mock("@/platform/intercom/blocker-gate", () => ({ BlockerGate: () => null }));

import AppGroupLayout from "./layout";
import { IntercomMessenger } from "@/platform/intercom/messenger";
import { BlockerGate } from "@/platform/intercom/blocker-gate";

const PERSON = {
  personId: "person-1",
  name: "Test Person",
  email: "t@example.com",
  themePreference: null,
  photoVersion: 1,
  blockerGateExempt: false,
};

/** Plain-object React element, matching what JSX without a renderer produces. */
type Element = { type: unknown; props: { children?: unknown; [key: string]: unknown } };

/** Walks the element tree (never calling any component function) collecting every element. */
function collectElements(node: unknown, out: Element[] = []): Element[] {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) collectElements(child, out);
    return out;
  }
  if ("type" in node && "props" in node) {
    const el = node as Element;
    out.push(el);
    collectElements(el.props.children, out);
  }
  return out;
}

async function renderLayout() {
  return collectElements(await AppGroupLayout({ children: null }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requirePersonSession.mockResolvedValue(PERSON);
  mocks.getActiveTerm.mockResolvedValue(null);
  mocks.reviewScope.mockResolvedValue({ all: false, departmentCodes: [] });
  mocks.isInterviewPanelist.mockResolvedValue(false);
  mocks.getSupportContact.mockResolvedValue({ email: "support@example.com", label: "Contact IT" });
  mocks.getSetting.mockResolvedValue(false);
  mocks.resolveSupportAppId.mockReturnValue("abc123");
  mocks.mintMessengerTokenForSession.mockResolvedValue({ ok: false, reason: "not_configured" });
});

describe("(app) layout Messenger + gate wiring", () => {
  it("mounts IntercomMessenger in identified mode when Intercom is configured", async () => {
    const messenger = (await renderLayout()).find((el) => el.type === IntercomMessenger);
    expect(messenger).toBeDefined();
    expect(messenger?.props.mode).toBe("identified");
  });

  /**
   * The hub must NOT carry the /apply portal's active-membership restriction: a
   * member between terms still signs in here and must still be identified. That
   * carve-out is the whole reason "between terms" is not an offboarded state, and
   * it lives in the ABSENCE of a prop, which is the kind of thing a well-meaning
   * "make the surfaces consistent" refactor adds without noticing.
   */
  it("does not ask for the active-membership restriction, unlike the /apply portal", async () => {
    const messenger = (await renderLayout()).find((el) => el.type === IntercomMessenger);
    expect(messenger?.props.requireActiveMembership).toBeUndefined();
  });

  it("mounts BlockerGate alongside it when the kill switch is on", async () => {
    mocks.getSetting.mockResolvedValue(true);
    const types = (await renderLayout()).map((el) => el.type);
    expect(types).toContain(IntercomMessenger);
    expect(types).toContain(BlockerGate);
  });

  it("does not mount BlockerGate when the runtime kill switch is off, even though the Messenger still mounts", async () => {
    mocks.getSetting.mockResolvedValue(false);
    const types = (await renderLayout()).map((el) => el.type);
    expect(types).toContain(IntercomMessenger);
    expect(types).not.toContain(BlockerGate);
  });

  // Every gate switch subtracts only from the gate, never from the Messenger:
  // standing the gate down must not take support away from someone who can
  // still reach it.
  it("does not mount BlockerGate for an exempt person, but still mounts the Messenger", async () => {
    mocks.getSetting.mockResolvedValue(true);
    mocks.requirePersonSession.mockResolvedValue({ ...PERSON, blockerGateExempt: true });
    const types = (await renderLayout()).map((el) => el.type);
    expect(types).toContain(IntercomMessenger);
    expect(types).not.toContain(BlockerGate);
  });

  it("mounts neither the Messenger nor the gate when the app id is unset", async () => {
    mocks.getSetting.mockResolvedValue(true);
    mocks.resolveSupportAppId.mockReturnValue(null);
    const types = (await renderLayout()).map((el) => el.type);
    expect(types).not.toContain(IntercomMessenger);
    expect(types).not.toContain(BlockerGate);
  });
});

describe("(app) layout server-minted token", () => {
  it("renders a token-less Messenger, without throwing, when minting fails unexpectedly", async () => {
    mocks.mintMessengerTokenForSession.mockRejectedValue(new Error("boom: unrecognized jose failure"));

    // If the layout does not contain the rejection, this await itself throws
    // and the test fails right here -- that IS the regression.
    const messenger = (await renderLayout()).find((el) => el.type === IntercomMessenger);

    expect(messenger).toBeDefined();
    expect(messenger?.props.initialToken).toBeNull();

    // The failure must not be silent: it is visible in logs even though the
    // render degrades cleanly.
    expect(mocks.logError).toHaveBeenCalledWith(
      expect.stringContaining("[intercom]"),
      expect.objectContaining({ "error.message": expect.stringContaining("boom") })
    );
  });

  it("passes the minted token through unchanged on a normal, successful mint", async () => {
    mocks.mintMessengerTokenForSession.mockResolvedValue({
      ok: true,
      token: "server.jwt",
      expiresInSeconds: 900,
    });

    const messenger = (await renderLayout()).find((el) => el.type === IntercomMessenger);

    // messengerToken.ok ? messengerToken : null narrows to (and passes through)
    // the whole success variant, `ok` field included.
    expect(messenger?.props.initialToken).toEqual({
      ok: true,
      token: "server.jwt",
      expiresInSeconds: 900,
    });
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it("passes a null token when the mint cleanly refuses, rather than a refusal object", async () => {
    mocks.mintMessengerTokenForSession.mockResolvedValue({ ok: false, reason: "db_unreachable" });

    const messenger = (await renderLayout()).find((el) => el.type === IntercomMessenger);

    // The component falls back to fetching on null. Handing it the refusal
    // object instead would be truthy, and it would try to boot on `undefined`.
    expect(messenger?.props.initialToken).toBeNull();
  });
});
