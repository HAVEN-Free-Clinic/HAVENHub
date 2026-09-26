// @vitest-environment jsdom
/**
 * Mounts CheckInPanel with the browser's location APIs stubbed, following
 * blocker-gate.test.tsx: a bare createRoot + act() mount, no testing-library.
 *
 * The case pinned here is the denied browser. It never prompts again, so every
 * tap is refused at once; in production (Sep 2026) that produced all 17 rage
 * clicks on Check in, because the retry restored identical copy and looked dead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CheckInPanel, type CheckInActionResult } from "./check-in-panel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A PermissionStatus stand-in whose state a test can flip, firing `change`. */
class FakePermissionStatus extends EventTarget {
  constructor(public state: PermissionState) {
    super();
  }
  set(state: PermissionState) {
    this.state = state;
    this.dispatchEvent(new Event("change"));
  }
}

/** watchPosition that refuses at once, as a denied browser does. */
const deniedGeo = {
  watchPosition: vi.fn((_ok: PositionCallback, err?: PositionErrorCallback | null) => {
    err?.({ code: 1, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3, message: "denied" } as GeolocationPositionError);
    return 1;
  }),
  clearWatch: vi.fn(),
};

let permission: FakePermissionStatus | null;
let mounted: { container: HTMLDivElement; root: Root } | null = null;
const report = vi.fn(async () => {});
const action = vi.fn(async (): Promise<CheckInActionResult> => ({ ok: false, reason: "UNAVAILABLE" }));

function installNavigator({ withPermissions }: { withPermissions: boolean }) {
  Object.defineProperty(navigator, "geolocation", { value: deniedGeo, configurable: true });
  if (withPermissions) {
    Object.defineProperty(navigator, "permissions", {
      value: { query: vi.fn(async () => permission) },
      configurable: true,
    });
  } else {
    // Older Safari: no Permissions API at all.
    Reflect.deleteProperty(navigator, "permissions");
  }
}

async function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<CheckInPanel mode="geo" action={action} reportClientFailure={report} />);
  });
  mounted = { container, root };
  return container;
}

const button = () => mounted!.container.querySelector("button")!;
const blockedAlert = () => mounted!.container.querySelector('[data-testid="check-in-blocked"]');

async function tap() {
  await act(async () => {
    button().click();
  });
}

beforeEach(() => {
  permission = null;
  report.mockClear();
  action.mockClear();
});

afterEach(() => {
  if (mounted) {
    const { root, container } = mounted;
    act(() => root.unmount());
    container.remove();
    mounted = null;
  }
});

describe("CheckInPanel, location denied", () => {
  it("says tapping will not help, gives steps, and names the director fallback", async () => {
    installNavigator({ withPermissions: false });
    await mount();
    await tap();

    const text = blockedAlert()?.textContent ?? "";
    expect(text).toMatch(/blocked for this site/);
    expect(text).toMatch(/will not work until you allow it/);
    expect(text).not.toMatch(/try again/i);
    expect(blockedAlert()!.querySelectorAll("li").length).toBeGreaterThan(0);
    expect(text).toMatch(/ask a director to check you in/);
    expect(report).toHaveBeenCalledWith("PERMISSION_DENIED");
  });

  it("visibly acknowledges each repeated denied tap and reports every one", async () => {
    installNavigator({ withPermissions: false });
    await mount();
    await tap();
    const first = blockedAlert();
    expect(first?.textContent).not.toMatch(/Still blocked/);

    await tap();
    const second = blockedAlert();
    expect(second?.textContent).toMatch(/Still blocked after 2 tries/);
    // A fresh node, so assistive tech announces it again.
    expect(second).not.toBe(first);

    await tap();
    expect(blockedAlert()?.textContent).toMatch(/Still blocked after 3 tries/);
    expect(report).toHaveBeenCalledTimes(3);
  });

  it("shows the block before any tap when the browser already reports denied", async () => {
    permission = new FakePermissionStatus("denied");
    installNavigator({ withPermissions: true });
    await mount();

    expect(blockedAlert()?.textContent).toMatch(/blocked for this site/);
    expect(report).not.toHaveBeenCalled();
  });

  it("clears the block without a reload once location is allowed", async () => {
    permission = new FakePermissionStatus("denied");
    installNavigator({ withPermissions: true });
    const container = await mount();
    expect(blockedAlert()).not.toBeNull();

    await act(async () => permission!.set("prompt"));
    expect(blockedAlert()).toBeNull();
    expect(container.textContent).toMatch(/Location is allowed now/);
  });

  it("shows nothing extra when a first prompt is answered with Allow", async () => {
    permission = new FakePermissionStatus("prompt");
    installNavigator({ withPermissions: true });
    const container = await mount();

    await act(async () => permission!.set("granted"));
    expect(blockedAlert()).toBeNull();
    expect(container.textContent).not.toMatch(/Location is allowed now/);
  });

  it("shows the block when permission is revoked while the page is open", async () => {
    permission = new FakePermissionStatus("granted");
    installNavigator({ withPermissions: true });
    await mount();
    expect(blockedAlert()).toBeNull();

    await act(async () => permission!.set("denied"));
    expect(blockedAlert()?.textContent).toMatch(/blocked for this site/);
  });
});
