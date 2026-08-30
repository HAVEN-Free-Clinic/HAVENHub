// @vitest-environment jsdom
/**
 * The /login boundary is the one path the StaleServerActionRecovery listener
 * cannot cover: the "Sign in with Yale" form posts a server action directly, and
 * React routes that rejection to a boundary rather than to a `window` error.
 * These tests pin that a stale action reloads once (and does not re-file the
 * exception it just recovered), while every other error keeps the branded retry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { UnrecognizedActionError } from "next/dist/client/components/unrecognized-action-error";
import { STALE_DEPLOY_MESSAGE } from "@/platform/posthog/stale-server-action";
import LoginError from "./error";

const { capture, captureException } = vi.hoisted(() => ({
  capture: vi.fn(),
  captureException: vi.fn(),
}));
vi.mock("posthog-js", () => ({ default: { capture, captureException } }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const reload = vi.fn();
// jsdom's window.location.reload is not itself redefinable, so replace the whole
// location object once. recoverOnce only reads location.reload.
Object.defineProperty(window, "location", {
  configurable: true,
  value: { href: "https://hub.havenfreeclinic.org/login", reload },
});
let mounted: { container: HTMLDivElement; root: Root } | null = null;

function mount(error: Error) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<LoginError error={error} reset={vi.fn()} />);
  });
  mounted = { container, root };
  return container;
}

/** The error Next throws when the running deploy does not know the action id. */
const staleError = () =>
  new UnrecognizedActionError(
    "Failed to find Server Action. This request might be from an older or newer deployment.",
  );

beforeEach(() => {
  sessionStorage.clear();
  reload.mockClear();
  capture.mockClear();
  captureException.mockClear();
});

afterEach(() => {
  if (mounted) {
    act(() => mounted!.root.unmount());
    mounted.container.remove();
    mounted = null;
  }
});

describe("LoginError", () => {
  it("reloads once and shows the reload copy for a stale Server Action", () => {
    const container = mount(staleError());
    expect(container.textContent).toContain(STALE_DEPLOY_MESSAGE);
    expect(container.textContent).not.toMatch(/try again/i);
    expect(reload).toHaveBeenCalledTimes(1);
    // Records the heal, and does not re-file the exception it just recovered.
    expect(capture).toHaveBeenCalledWith("client_stale_server_action_recovered");
    expect(captureException).not.toHaveBeenCalled();
  });

  it("keeps the branded retry and reports every other error", () => {
    const boom = new Error("boom");
    const container = mount(boom);
    expect(container.textContent).toMatch(/try again/i);
    expect(reload).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledWith(boom);
  });

  it("does not reload a second time once this tab has spent its one reload", () => {
    sessionStorage.setItem("haven:stale-server-action-recovered", "1");
    mount(staleError());
    expect(reload).not.toHaveBeenCalled();
  });
});
