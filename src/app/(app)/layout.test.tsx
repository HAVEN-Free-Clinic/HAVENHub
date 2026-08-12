/**
 * Wiring test for the (app) group layout: which two Messenger-related client
 * components does it actually mount, and under what conditions.
 *
 * AppGroupLayout is called directly as a plain async function (no ReactDOM
 * render): its return value is an unrendered React element tree, so this
 * walks Fragments to find the top-level elements it produced WITHOUT
 * invoking AppShell or any other function component. That is enough to prove
 * wiring -- IntercomMessenger and BlockerGate are compared by the actual
 * imported function reference, not by name, so a refactor that renames or
 * re-exports either one still gets caught.
 *
 * This is also the positive half of the blocker-gate scoping requirement: see
 * apply/layout.test.tsx and login/layout.test.tsx for the negative half (a
 * public surface that mounts the Messenger but never BlockerGate).
 */
import { Fragment, isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// AppShell (imported transitively, never invoked here) pulls in signOut from
// this module, which drags in next-auth -- mocked purely to keep that import
// chain out of this unit test, same pattern as the route tests that mock
// @/platform/auth/auth.
vi.mock("@/platform/auth/auth", () => ({ signOut: vi.fn() }));

vi.mock("@/platform/auth/session", () => ({
  requirePersonSession: vi.fn(async () => ({
    personId: "p1",
    name: "Sam Rivera",
    email: "sam@example.com",
    themePreference: null,
    photoVersion: 1,
  })),
}));
vi.mock("@/platform/terms/active-term", () => ({ getActiveTerm: vi.fn(async () => null) }));
vi.mock("@/modules/recruitment/services/review", () => ({
  reviewScope: vi.fn(async () => ({ all: false, departmentCodes: [] })),
}));
vi.mock("@/modules/recruitment/services/interviews", () => ({
  isInterviewPanelist: vi.fn(async () => false),
}));
vi.mock("@/platform/branding/support", () => ({
  getSupportContact: vi.fn(async () => ({ email: "help@example.org", label: "Contact support" })),
}));

let blockerGateEnabled = true;
vi.mock("@/platform/settings/service", () => ({
  getSetting: vi.fn(async (key: string) => (key === "support.blockerGateEnabled" ? blockerGateEnabled : null)),
}));

import AppGroupLayout from "./layout";
import { IntercomMessenger } from "@/platform/intercom/messenger";
import { BlockerGate } from "@/platform/intercom/blocker-gate";

/** Walks Fragments (and arrays of children) only -- never invokes a function
 *  component -- collecting every element `type` reference it finds. */
function collectTypes(node: ReactNode, found: Set<unknown> = new Set()): Set<unknown> {
  if (node === null || node === undefined || typeof node === "boolean") return found;
  if (Array.isArray(node)) {
    for (const child of node) collectTypes(child, found);
    return found;
  }
  if (!isValidElement(node)) return found;
  found.add(node.type);
  if (node.type === Fragment || typeof node.type === "string") {
    collectTypes((node.props as { children?: ReactNode }).children, found);
  }
  return found;
}

beforeEach(() => {
  blockerGateEnabled = true;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("(app) layout Messenger + gate wiring", () => {
  it("mounts IntercomMessenger in identified mode when Intercom is configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_INTERCOM_APP_ID", "unyx5lb2");
    vi.stubEnv("INTERCOM_MESSENGER_SECRET", "shh");
    const tree = (await AppGroupLayout({ children: null })) as ReactElement;
    const types = collectTypes(tree);
    expect(types.has(IntercomMessenger)).toBe(true);
  });

  it("mounts BlockerGate alongside it when the kill switch is on", async () => {
    vi.stubEnv("NEXT_PUBLIC_INTERCOM_APP_ID", "unyx5lb2");
    vi.stubEnv("INTERCOM_MESSENGER_SECRET", "shh");
    blockerGateEnabled = true;
    const tree = (await AppGroupLayout({ children: null })) as ReactElement;
    const types = collectTypes(tree);
    expect(types.has(BlockerGate)).toBe(true);
  });

  it("does not mount BlockerGate when the runtime kill switch is off, even though the Messenger still mounts", async () => {
    vi.stubEnv("NEXT_PUBLIC_INTERCOM_APP_ID", "unyx5lb2");
    vi.stubEnv("INTERCOM_MESSENGER_SECRET", "shh");
    blockerGateEnabled = false;
    const tree = (await AppGroupLayout({ children: null })) as ReactElement;
    const types = collectTypes(tree);
    expect(types.has(IntercomMessenger)).toBe(true);
    expect(types.has(BlockerGate)).toBe(false);
  });

  it("mounts neither the Messenger nor the gate when the app id is unset", async () => {
    vi.stubEnv("NEXT_PUBLIC_INTERCOM_APP_ID", "");
    vi.stubEnv("INTERCOM_MESSENGER_SECRET", "shh");
    const tree = (await AppGroupLayout({ children: null })) as ReactElement;
    const types = collectTypes(tree);
    expect(types.has(IntercomMessenger)).toBe(false);
    expect(types.has(BlockerGate)).toBe(false);
  });
});
