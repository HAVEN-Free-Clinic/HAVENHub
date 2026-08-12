/**
 * Wiring test for the /get-started layout (wraps the checklist and every
 * onboarding task sub-route): identified mode, unconditionally -- every route
 * under here is reached through requirePersonSession, so a Person always
 * exists. Never BlockerGate -- that stays (app)-only, see blocker-gate.tsx.
 */
import { Fragment, isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import GetStartedLayout from "./layout";
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
  if (node.type === Fragment || typeof node.type === "string") {
    findElements((node.props as { children?: ReactNode }).children, type, found);
  }
  return found;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/get-started layout Messenger wiring", () => {
  it("mounts IntercomMessenger in identified mode with no requireActiveMembership", async () => {
    vi.stubEnv("NEXT_PUBLIC_INTERCOM_APP_ID", "unyx5lb2");
    vi.stubEnv("INTERCOM_MESSENGER_SECRET", "shh");
    const tree = GetStartedLayout({ children: null }) as ReactElement;
    const [el] = findElements(tree, IntercomMessenger);
    expect(el).toBeDefined();
    expect(el.props).toMatchObject({ appId: "unyx5lb2", mode: "identified" });
    expect("requireActiveMembership" in (el.props as Record<string, unknown>)).toBe(false);
  });

  it("never mounts BlockerGate -- that stays (app)-only", async () => {
    vi.stubEnv("NEXT_PUBLIC_INTERCOM_APP_ID", "unyx5lb2");
    vi.stubEnv("INTERCOM_MESSENGER_SECRET", "shh");
    const tree = GetStartedLayout({ children: null }) as ReactElement;
    expect(findElements(tree, BlockerGate)).toHaveLength(0);
  });

  it("mounts nothing when the app id is unset", async () => {
    vi.stubEnv("NEXT_PUBLIC_INTERCOM_APP_ID", "");
    vi.stubEnv("INTERCOM_MESSENGER_SECRET", "shh");
    const tree = GetStartedLayout({ children: null }) as ReactElement;
    expect(findElements(tree, IntercomMessenger)).toHaveLength(0);
  });
});
