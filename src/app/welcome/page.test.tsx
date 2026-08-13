/**
 * Wiring test for /welcome: identified mode with no requireActiveMembership.
 * This page is reached precisely when the session does NOT resolve to a
 * Person (every other case redirects into the hub before render), so the
 * interesting property to prove is just that it mounts unconditionally on
 * the one path that actually reaches render. Never BlockerGate -- that stays
 * (app)-only, see blocker-gate.tsx.
 */
import { Fragment, isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/platform/auth/auth", () => ({ auth: vi.fn(async () => null), signOut: vi.fn() }));
vi.mock("@/platform/auth/match-person", () => ({ resolvePersonForLogin: vi.fn() }));
vi.mock("@/platform/db", () => ({
  prisma: { recruitmentCycle: { count: vi.fn(async () => 0) } },
}));
vi.mock("@/platform/settings/service", () => ({ getSetting: vi.fn(async () => "HAVEN Free Clinic") }));
vi.mock("@/platform/branding/support", () => ({
  getSupportContact: vi.fn(async () => ({ email: "help@example.org", label: "Contact support" })),
}));

import WelcomePage from "./page";
import { IntercomMessenger } from "@/platform/intercom/messenger";
import { BlockerGate } from "@/platform/intercom/blocker-gate";

function findElements(node: ReactNode, type: unknown, found: ReactElement[] = []): ReactElement[] {
  if (node === null || node === undefined || typeof node === "boolean") return found;
  if (Array.isArray(node)) {
    for (const child of node) findElements(child, type, found);
    return found;
  }
  if (!isValidElement(node)) return found;
  if (node.type === type) found.push(node);
  // Recurse through Fragments and plain host elements (<main>, <div>, ...) --
  // both are already-constructed tree nodes, safe to walk without invoking
  // anything. Never recurse into a custom component's children prop: that is
  // data handed to an unexecuted function, not its rendered output.
  if (node.type === Fragment || typeof node.type === "string") {
    findElements((node.props as { children?: ReactNode }).children, type, found);
  }
  return found;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/welcome Messenger wiring", () => {
  it("mounts IntercomMessenger in identified mode with no requireActiveMembership", async () => {
    vi.stubEnv("NEXT_PUBLIC_INTERCOM_APP_ID", "unyx5lb2");
    vi.stubEnv("INTERCOM_MESSENGER_SECRET", "shh");
    const tree = (await WelcomePage()) as ReactElement;
    const [el] = findElements(tree, IntercomMessenger);
    expect(el).toBeDefined();
    expect(el.props).toMatchObject({ appId: "unyx5lb2", mode: "identified" });
    expect("requireActiveMembership" in (el.props as Record<string, unknown>)).toBe(false);
  });

  it("never mounts BlockerGate -- that stays (app)-only", async () => {
    vi.stubEnv("NEXT_PUBLIC_INTERCOM_APP_ID", "unyx5lb2");
    vi.stubEnv("INTERCOM_MESSENGER_SECRET", "shh");
    const tree = (await WelcomePage()) as ReactElement;
    expect(findElements(tree, BlockerGate)).toHaveLength(0);
  });

  it("mounts nothing when the app id is unset", async () => {
    vi.stubEnv("NEXT_PUBLIC_INTERCOM_APP_ID", "");
    vi.stubEnv("INTERCOM_MESSENGER_SECRET", "shh");
    const tree = (await WelcomePage()) as ReactElement;
    expect(findElements(tree, IntercomMessenger)).toHaveLength(0);
  });
});
