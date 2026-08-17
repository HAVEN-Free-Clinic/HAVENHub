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

// The layout resolves who the portal signed this browser in as, so the
// Messenger's anonymous fallback boot can be labelled with a name (see
// visitor.ts). Both are stubbed rather than hit: these tests are about prop
// wiring, and portal-auth reads a real session and a real Person row.
type Identity = { email: string; personId: string | null; firstName: string | null } | null;
let identity: Identity = null;
vi.mock("@/modules/recruitment/services/portal-auth", () => ({
  getApplicantIdentity: vi.fn(async () => identity),
}));

let personName: string | null = null;
vi.mock("@/platform/db", () => ({
  prisma: { person: { findUnique: vi.fn(async () => (personName ? { name: personName } : null)) } },
}));

import ApplyPortalLayout from "./layout";
import { IntercomMessenger } from "@/platform/intercom/messenger";
import { BlockerGate } from "@/platform/intercom/blocker-gate";
import { getApplicantIdentity } from "@/modules/recruitment/services/portal-auth";

/** Reads through both prop shapes: the sign-in branch omits the prop entirely,
 *  the identified branch passes an explicit undefined. */
function visitorAttributesOf(el: ReactElement): unknown {
  return (el.props as { visitorAttributes?: unknown }).visitorAttributes;
}

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
  identity = null;
  personName = null;
  vi.clearAllMocks();
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

  /**
   * The applicant-attribution wiring. An applicant boots as a visitor (the
   * token route refuses them), which is why they show up in Intercom nameless;
   * these attributes are what tell an agent who they are without identifying
   * the contact. See platform/intercom/visitor.ts for the trust argument.
   */
  describe("visitor identity attributes", () => {
    it("passes the signed-in applicant's name and email through to the Messenger", async () => {
      configureIntercom();
      identity = { email: "jane.doe@yale.edu", personId: null, firstName: "Jane" };
      const tree = (await ApplyPortalLayout({ children: null })) as ReactElement;
      const [el] = findElements(tree, IntercomMessenger);
      expect(el.props).toMatchObject({
        visitorAttributes: {
          "Portal sign-in name": "Jane",
          "Portal sign-in email": "jane.doe@yale.edu",
        },
      });
    });

    it("prefers the stored Person name over the first name from the sign-in", async () => {
      configureIntercom();
      identity = { email: "jane.doe@yale.edu", personId: "person-1", firstName: "Jane" };
      personName = "Jane Doe";
      const tree = (await ApplyPortalLayout({ children: null })) as ReactElement;
      const [el] = findElements(tree, IntercomMessenger);
      expect(el.props).toMatchObject({
        visitorAttributes: { "Portal sign-in name": "Jane Doe" },
      });
    });

    it("passes nothing for a signed-out visitor", async () => {
      configureIntercom();
      identity = null;
      const tree = (await ApplyPortalLayout({ children: null })) as ReactElement;
      const [el] = findElements(tree, IntercomMessenger);
      expect(visitorAttributesOf(el)).toBeUndefined();
    });

    /**
     * Not an optimization. /apply/verify boots as a visitor precisely because
     * whatever session is on the request is not yet the identity the browser is
     * establishing, so labelling that boot with the outgoing session's name is
     * the one place these attributes would be actively wrong.
     */
    it("sends nothing on the magic-link sign-in surface, even with a session on the request", async () => {
      configureIntercom();
      pathname = "/apply/verify";
      identity = { email: "someone.else@yale.edu", personId: null, firstName: "Someone" };
      const tree = (await ApplyPortalLayout({ children: null })) as ReactElement;
      const [el] = findElements(tree, IntercomMessenger);
      expect(el.props).toMatchObject({ mode: "visitor" });
      expect(visitorAttributesOf(el)).toBeUndefined();
      // Never even asked: the skip is a decision about correctness on this
      // surface, not a lazy branch that happens to produce undefined.
      expect(vi.mocked(getApplicantIdentity)).not.toHaveBeenCalled();
    });
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
