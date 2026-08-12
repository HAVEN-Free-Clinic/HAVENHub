/**
 * Wiring test for the /login layout (also wraps /login/verify): always
 * visitor mode, and never BlockerGate -- see blocker-gate.tsx's own doc
 * comment on why the gate is (app)-only. Same direct-call approach as
 * (app)/layout.test.tsx and apply/layout.test.tsx.
 */
import { Fragment, isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import LoginLayout from "./layout";
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

describe("/login layout Messenger wiring", () => {
  it("mounts IntercomMessenger in visitor mode -- this layout never even checks for a session", async () => {
    vi.stubEnv("NEXT_PUBLIC_INTERCOM_APP_ID", "unyx5lb2");
    vi.stubEnv("INTERCOM_MESSENGER_SECRET", "shh");
    const tree = LoginLayout({ children: null }) as ReactElement;
    const [el] = findElements(tree, IntercomMessenger);
    expect(el).toBeDefined();
    expect(el.props).toMatchObject({ appId: "unyx5lb2", mode: "visitor" });
  });

  it("never mounts BlockerGate -- that stays (app)-only", async () => {
    vi.stubEnv("NEXT_PUBLIC_INTERCOM_APP_ID", "unyx5lb2");
    vi.stubEnv("INTERCOM_MESSENGER_SECRET", "shh");
    const tree = LoginLayout({ children: null }) as ReactElement;
    expect(findElements(tree, BlockerGate)).toHaveLength(0);
  });

  it("mounts nothing when the app id is unset", async () => {
    vi.stubEnv("NEXT_PUBLIC_INTERCOM_APP_ID", "");
    vi.stubEnv("INTERCOM_MESSENGER_SECRET", "shh");
    const tree = LoginLayout({ children: null }) as ReactElement;
    expect(findElements(tree, IntercomMessenger)).toHaveLength(0);
  });
});
