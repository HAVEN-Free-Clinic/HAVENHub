// @vitest-environment jsdom
/**
 * Mounts FlashReader end-to-end against the real classifier (`./flash`) and
 * the real toast primitive (`./toast`), driving `next/navigation` through a
 * mutable mock rather than asserting on `classifyFlashParams` output in
 * isolation (that is `flash.test.ts`'s job). This is what actually proves
 * the wiring: a rendered toast confirms classification, `router.replace`
 * confirms param preservation, and both together confirm the
 * applicant-portal pathname fix end to end. Follows `toast.test.tsx`'s
 * approach: a bare `createRoot` + `act()` mount, no testing-library.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FlashReader } from "./flash-reader";
import { ToastProvider, ToastViewport } from "./toast";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let mockPathname = "/";
let mockSearch = "";
let replaceCalls: string[] = [];

vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
  useSearchParams: () => new URLSearchParams(mockSearch),
  useRouter: () => ({ replace: (href: string) => replaceCalls.push(href) }),
}));

let mounted: { container: HTMLDivElement; root: Root } | null = null;

function mount(isPortalHost: boolean, strict = false) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const tree = (
    <ToastProvider>
      <FlashReader isPortalHost={isPortalHost} />
      <ToastViewport />
    </ToastProvider>
  );
  act(() => {
    root.render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  });
  // ToastViewport defers its first portal render by one tick past mount to
  // stay hydration-safe (see toast.tsx); flush that tick with fake timers so
  // the assertions below see it immediately.
  act(() => {
    vi.advanceTimersByTime(0);
  });
  mounted = { container, root };
  return container;
}

beforeEach(() => {
  vi.useFakeTimers();
  mockPathname = "/";
  mockSearch = "";
  replaceCalls = [];
});

afterEach(() => {
  if (mounted) {
    act(() => {
      mounted!.root.unmount();
    });
    mounted.container.remove();
    mounted = null;
  }
  vi.useRealTimers();
});

describe("the applicant portal host's pathname resolution", () => {
  // apply/verify/page.tsx redirects an expired sign-in link to "/apply?error=link"
  // (flash.ts's ERROR_CODE_TABLE, scoped to exactly "/apply"). On
  // apply.havenfreeclinic.org, the portal home is served by proxying "/" onto
  // "/apply" server-side (src/proxy.ts) without ever touching the browser
  // URL, so usePathname() reports bare "/" -- never "/apply" -- for exactly
  // this page. isPortalHost (resolved server-side, in the root layout) is
  // what tells this reader to undo that rewrite before classifying.
  it("resolves error=link on the portal home's pre-rewrite pathname to the /apply-scoped entry", () => {
    mockPathname = "/";
    mockSearch = "error=link";
    mount(/* isPortalHost */ true);

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "That link has expired or was already used. Request a new one below.",
    );
  });

  it("does NOT resolve error=link when isPortalHost is false, proving the flag is load-bearing", () => {
    // Same raw pathname ("/"), but without portal-host resolution: "/" is
    // the signed-in app's own dashboard, not "/apply", so the code table's
    // /apply-scoped entry does not match and the raw code "link" passes
    // through as the message unchanged -- exactly the bug this reader
    // exists to avoid on the real portal host.
    mockPathname = "/";
    mockSearch = "error=link";
    mount(/* isPortalHost */ false);

    expect(document.querySelector('[role="alert"]')?.textContent).toContain("link");
    expect(document.querySelector('[role="alert"]')?.textContent).not.toContain(
      "expired or was already used",
    );
  });

  it("does not extend the /apply-scoped link text to a cycle subpage", () => {
    // "/some-slug" (a cycle page) rewrites to "/apply/some-slug", which does
    // not match the code table's exact "/apply" pattern -- only the bare
    // portal home does, matching apply/verify/page.tsx's real redirect
    // target. This pins that the fix does not over-apply.
    mockPathname = "/some-slug";
    mockSearch = "error=link";
    mount(/* isPortalHost */ true);

    expect(document.querySelector('[role="alert"]')?.textContent).toContain("link");
    expect(document.querySelector('[role="alert"]')?.textContent).not.toContain(
      "expired or was already used",
    );
  });
});

describe("suppressing error=signin on /apply for the inline sign-in alert", () => {
  // portalYaleSignInAction (src/app/apply/portal-actions.ts) redirects a failed Yale
  // sign-in to "/apply?error=signin", and apply/page.tsx renders its own inline
  // <Alert> for that value (flash.ts's SUPPRESSED_ERROR_VALUES, value-scoped so
  // error=link -- the OTHER /apply error code, above -- still pops a toast). Unlike
  // the link tests above, the raw pathname here is "/apply" itself, not "/": "apply"
  // is a reserved portal slug (portal-routing.ts's RESERVED_PORTAL_SLUGS), so on the
  // portal host isPortalPassThrough treats a raw "/apply" as a pass-through and
  // resolveEffectivePathname leaves it unrewritten -- converging with the hub host's
  // own literal "/apply" on the same effective pathname either way.
  it("suppresses error=signin on the hub host", () => {
    mockPathname = "/apply";
    mockSearch = "error=signin";
    mount(/* isPortalHost */ false);

    expect(document.querySelectorAll('[role="status"], [role="alert"]')).toHaveLength(0);
    expect(replaceCalls).toHaveLength(0);
  });

  it("suppresses error=signin on the portal host too, since /apply is itself a reserved pass-through slug", () => {
    mockPathname = "/apply";
    mockSearch = "error=signin";
    mount(/* isPortalHost */ true);

    expect(document.querySelectorAll('[role="status"], [role="alert"]')).toHaveLength(0);
    expect(replaceCalls).toHaveLength(0);
  });
});

describe("param preservation", () => {
  it("strips only the flash param, preserving a filter param present alongside it", () => {
    mockPathname = "/admin/settings";
    mockSearch = "saved=1&status=FAILED";
    mount(false);

    expect(document.querySelector('[role="status"]')?.textContent).toContain("Saved.");
    expect(replaceCalls).toHaveLength(1);
    const url = new URL(replaceCalls[0], "http://test.local");
    expect(url.pathname).toBe("/admin/settings");
    expect(url.searchParams.get("status")).toBe("FAILED");
    expect(url.searchParams.has("saved")).toBe(false);
  });

  it("issues no replace at all when nothing on the URL classifies as a flash", () => {
    mockPathname = "/admin/settings";
    mockSearch = "status=FAILED";
    mount(false);

    expect(document.querySelectorAll('[role="status"], [role="alert"]')).toHaveLength(0);
    expect(replaceCalls).toHaveLength(0);
  });
});

describe("re-fire guard", () => {
  it("does not push a duplicate toast under StrictMode's double effect invocation", () => {
    mockPathname = "/admin/settings";
    mockSearch = "saved=1";
    mount(false, /* strict */ true);

    expect(document.querySelectorAll('[role="status"], [role="alert"]')).toHaveLength(1);
    expect(replaceCalls).toHaveLength(1);
  });
});
