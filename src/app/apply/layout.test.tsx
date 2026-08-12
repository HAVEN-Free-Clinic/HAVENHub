/**
 * Wiring test for the /apply portal layout: which mode does it hand
 * IntercomMessenger, and does it ever mount BlockerGate (it must not -- see
 * blocker-gate.tsx's own doc comment on why the gate is (app)-only).
 *
 * ApplyPortalLayout is called directly as a plain async function (same
 * approach as (app)/layout.test.tsx): the returned element tree is walked
 * without invoking any component, which is enough to prove the mode/prop
 * wiring without needing a full DOM render.
 */
import { Fragment, isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

let pathname: string | null = "/apply";
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: (name: string) => (name === "x-pathname" ? pathname : null) })),
}));

import ApplyPortalLayout from "./layout";
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
  pathname = "/apply";
});

function configureIntercom() {
  vi.stubEnv("NEXT_PUBLIC_INTERCOM_APP_ID", "unyx5lb2");
  vi.stubEnv("INTERCOM_MESSENGER_SECRET", "shh");
}

describe("/apply layout Messenger wiring", () => {
  it("mounts IntercomMessenger identified with requireActiveMembership on the portal home", async () => {
    configureIntercom();
    pathname = "/apply";
    const tree = (await ApplyPortalLayout({ children: null })) as ReactElement;
    const [el] = findElements(tree, IntercomMessenger);
    expect(el).toBeDefined();
    expect(el.props).toMatchObject({ appId: "unyx5lb2", mode: "identified", requireActiveMembership: true });
  });

  it("mounts the same identified+requireActiveMembership mode on a cycle application page", async () => {
    configureIntercom();
    pathname = "/apply/some-cycle-slug";
    const tree = (await ApplyPortalLayout({ children: null })) as ReactElement;
    const [el] = findElements(tree, IntercomMessenger);
    expect(el.props).toMatchObject({ mode: "identified", requireActiveMembership: true });
  });

  it("mounts visitor mode, unconditionally, on the magic-link sign-in confirmation screen -- the portal's own sign-in surface", async () => {
    configureIntercom();
    pathname = "/apply/verify";
    const tree = (await ApplyPortalLayout({ children: null })) as ReactElement;
    const [el] = findElements(tree, IntercomMessenger);
    expect(el.props).toMatchObject({ appId: "unyx5lb2", mode: "visitor" });
    // Never both modes at once.
    expect(findElements(tree, IntercomMessenger)).toHaveLength(1);
  });

  it("never mounts BlockerGate -- that stays (app)-only", async () => {
    configureIntercom();
    pathname = "/apply";
    const tree = (await ApplyPortalLayout({ children: null })) as ReactElement;
    expect(findElements(tree, BlockerGate)).toHaveLength(0);
  });

  it("mounts nothing when the app id is unset", async () => {
    vi.stubEnv("NEXT_PUBLIC_INTERCOM_APP_ID", "");
    vi.stubEnv("INTERCOM_MESSENGER_SECRET", "shh");
    pathname = "/apply";
    const tree = (await ApplyPortalLayout({ children: null })) as ReactElement;
    expect(findElements(tree, IntercomMessenger)).toHaveLength(0);
    expect(findElements(tree, BlockerGate)).toHaveLength(0);
  });
});
