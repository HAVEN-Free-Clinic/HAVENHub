/**
 * Wiring test for /welcome: identified mode with no requireActiveMembership.
 * This page is reached precisely when the session does NOT resolve to an ACTIVE
 * Person (every other case redirects into the hub before render), so the
 * interesting property to prove is just that it mounts unconditionally on
 * the one path that actually reaches render. Never BlockerGate -- that stays
 * (app)-only, see blocker-gate.tsx.
 *
 * Plus the escape hatch: an offboarded member holding a live JWT must land here
 * and STAY here, because this page owns the only Sign out button they can reach.
 */
import { Fragment, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => vi.fn(async () => null as { personId?: string | null; applicantEmail?: string } | null));
const getActivePerson = vi.hoisted(() => vi.fn(async (_id: string) => null as { id: string } | null));
// Thrown rather than returned, exactly like next/navigation's own redirect: a
// case that expects render must fail loudly if the page bounces instead.
const redirect = vi.hoisted(() =>
  vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
);

vi.mock("next/navigation", () => ({ redirect }));
vi.mock("@/platform/auth/auth", () => ({ auth, signOut: vi.fn() }));
vi.mock("@/platform/auth/match-person", () => ({ resolvePersonForLogin: vi.fn(), getActivePerson }));
vi.mock("@/platform/db", () => ({
  prisma: { recruitmentCycle: { count: vi.fn(async () => 0) } },
}));
vi.mock("@/platform/settings/service", () => ({ getSetting: vi.fn(async () => "HAVEN Free Clinic") }));
vi.mock("@/platform/branding/support", () => ({
  getSupportContact: vi.fn(async () => ({ email: "help@example.org", label: "Contact support" })),
}));
// Async Server Components nested in the returned tree. renderToStaticMarkup is a
// synchronous renderer, so it throws "a component suspended" the moment it hits
// one; stub them to the plain markup they contribute, which none of the
// assertions here are about.
vi.mock("@/platform/ui/haven-logo", () => ({ HavenLogo: () => <span>HAVEN</span> }));
vi.mock("@/platform/ui/app-footer", () => ({ CopyrightNotice: () => <span>(c)</span> }));

import WelcomePage from "./page";
import { resolvePersonForLogin } from "@/platform/auth/match-person";
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

beforeEach(() => {
  auth.mockImplementation(async () => null);
  getActivePerson.mockImplementation(async () => null);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("/welcome for a session that no longer opens the hub", () => {
  it("keeps an offboarded member here, with a working sign-out", async () => {
    // The (app) layout re-reads Person.status on every render and sends an
    // offboarded member to /welcome. /welcome used to read personId off the JWT
    // alone and send them straight back, so the two pages bounced the visitor
    // between them until the browser gave up -- and neither /login nor this
    // page's Sign out button was ever reachable, leaving them no way to clear
    // the session that caused it (audit 14).
    auth.mockImplementation(async () => ({ personId: "person-1" }));
    getActivePerson.mockImplementation(async () => null);
    const html = renderToStaticMarkup((await WelcomePage()) as ReactElement);
    expect(redirect).not.toHaveBeenCalled();
    expect(html).toContain("Sign out");
    // Told what actually happened, not "we couldn't find you in our records".
    expect(html).toContain("no longer active");
  });

  it("does not run the promoted-applicant self-heal for a token that names a Person", async () => {
    // That resolver LINKS the Entra oid as a side effect. It is for a session
    // carrying no personId at all; an offboarded member's carries one.
    auth.mockImplementation(async () => ({ personId: "person-1", applicantEmail: "gone@yale.edu" }));
    getActivePerson.mockImplementation(async () => null);
    renderToStaticMarkup((await WelcomePage()) as ReactElement);
    expect(resolvePersonForLogin).not.toHaveBeenCalled();
  });

  it("sends a still-active member into the hub", async () => {
    auth.mockImplementation(async () => ({ personId: "person-1" }));
    getActivePerson.mockImplementation(async () => ({ id: "person-1" }));
    await expect(WelcomePage()).rejects.toThrow("NEXT_REDIRECT:/");
  });
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
