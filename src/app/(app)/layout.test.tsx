/**
 * Proves mintMessengerTokenForSession's blast radius is contained at this
 * layout's Promise.all. That function only converts a recognized
 * DB-unreachable error shape into a clean refusal; everything else (an
 * unrecognized DB error, a jose failure, a bug in getEffectivePermissions)
 * rethrows -- correct for its original caller, the token route, where an
 * unhandled rejection is a contained 500 on /api/support/messenger-token
 * alone. This layout became its second caller, and an unhandled rejection
 * inside Promise.all here would reject the ENTIRE authenticated hub for
 * every signed-in member over what should be a support-only failure.
 *
 * Real element tree, no renderer: AppGroupLayout is an async Server
 * Component, so calling it directly and walking the returned React elements
 * (plain {type, props} objects) proves both that the promise settles and
 * what IntercomMessenger actually receives, without needing jsdom or
 * mocking the read-only UI components it composes with (AppShell,
 * PostHogIdentify, BlockerGate are stubbed only so their own heavy import
 * chains do not have to be dragged in here).
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
  isIntercomConfigured: vi.fn(),
  intercomAppId: vi.fn(),
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
vi.mock("@/platform/intercom/mint-token", () => ({
  mintMessengerTokenForSession: mocks.mintMessengerTokenForSession,
}));
vi.mock("@/platform/intercom/config", () => ({
  isIntercomConfigured: mocks.isIntercomConfigured,
  intercomAppId: mocks.intercomAppId,
}));
vi.mock("@/platform/logging", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: mocks.logError },
  errorAttrs: (err: unknown) => ({ "error.message": String(err) }),
}));
// Stubbed so importing this test file does not drag in their own (unrelated,
// heavy) import chains. They are never invoked either way: building a React
// element tree without a renderer never calls the referenced component
// functions.
vi.mock("@/platform/ui/app-shell", () => ({ AppShell: () => null }));
vi.mock("@/platform/posthog/posthog-identify", () => ({ PostHogIdentify: () => null }));
vi.mock("@/platform/intercom/blocker-gate", () => ({ BlockerGate: () => null }));

import AppGroupLayout from "./layout";
import { IntercomMessenger } from "@/platform/intercom/messenger";

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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requirePersonSession.mockResolvedValue(PERSON);
  mocks.getActiveTerm.mockResolvedValue(null);
  mocks.reviewScope.mockResolvedValue({ all: false, departmentCodes: [] });
  mocks.isInterviewPanelist.mockResolvedValue(false);
  mocks.getSupportContact.mockResolvedValue({ email: "support@example.com", label: "Contact IT" });
  mocks.getSetting.mockResolvedValue(false);
  mocks.isIntercomConfigured.mockReturnValue(true);
  mocks.intercomAppId.mockReturnValue("abc123");
});

describe("AppGroupLayout", () => {
  it("renders a token-less Messenger, without throwing, when minting fails unexpectedly", async () => {
    mocks.mintMessengerTokenForSession.mockRejectedValue(new Error("boom: unrecognized jose failure"));

    // If the layout does not contain the rejection, this await itself throws
    // and the test fails right here -- that IS the regression.
    const element = await AppGroupLayout({ children: null });

    const messenger = collectElements(element).find((el) => el.type === IntercomMessenger);
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

    const element = await AppGroupLayout({ children: null });

    const messenger = collectElements(element).find((el) => el.type === IntercomMessenger);
    // messengerToken.ok ? messengerToken : null narrows to (and passes through)
    // the whole success variant, `ok` field included.
    expect(messenger?.props.initialToken).toEqual({
      ok: true,
      token: "server.jwt",
      expiresInSeconds: 900,
    });
    expect(mocks.logError).not.toHaveBeenCalled();
  });
});
