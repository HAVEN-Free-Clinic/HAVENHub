// @vitest-environment jsdom
/**
 * Drives the readiness store through a mounted component, following
 * messenger-actions.test.tsx's approach: a bare createRoot + act() mount, no
 * testing-library. Reading it through useMessengerReadiness rather than an
 * exported variable keeps the module's only public reader under test, and
 * proves the store actually re-renders on a verdict instead of just recording
 * one.
 *
 * The DOM events here are real. The whole value of this module is that it reads
 * the browser's own verdict on the widget script, so a test that stubbed the
 * events away would prove nothing about a blocked request.
 *
 * The store holds module-level state on purpose (see its doc comment on why
 * listeners are never detached), so every test re-imports it through
 * vi.resetModules().
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Must match SDK_SCRIPT_ID in ./messenger-readiness. */
const SDK_SCRIPT_ID = "_intercom_npm_loader";

let mounted: { container: HTMLDivElement; root: Root } | null = null;

/**
 * A fresh copy of the module plus a mounted reader of it. Returns the container
 * whose text is the current readiness, so assertions read as
 * `expect(view.textContent).toBe("ready")`.
 */
async function mountReader() {
  vi.resetModules();
  const mod = await import("./messenger-readiness");

  function Reader() {
    return <>{mod.useMessengerReadiness()}</>;
  }

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Reader />);
  });
  mounted = { container, root };
  return { ...mod, view: container };
}

/** Stands in for the tag @intercom/messenger-js-sdk injects during Intercom(). */
function injectSdkScript(): HTMLScriptElement {
  const script = document.createElement("script");
  script.id = SDK_SCRIPT_ID;
  document.head.appendChild(script);
  return script;
}

async function fire(target: EventTarget, type: string) {
  await act(async () => {
    target.dispatchEvent(new Event(type));
  });
}

afterEach(() => {
  if (mounted) {
    const { container, root } = mounted;
    act(() => root.unmount());
    container.remove();
    mounted = null;
  }
  document.getElementById(SDK_SCRIPT_ID)?.remove();
});

describe("useMessengerReadiness", () => {
  it("reports ready once the widget script loads", async () => {
    const { watchMessengerScript, view } = await mountReader();
    const script = injectSdkScript();

    watchMessengerScript();
    expect(view.textContent).toBe("pending");

    await fire(script, "load");
    expect(view.textContent).toBe("ready");
  });

  it("reports unreachable when the widget script is blocked or fails", async () => {
    const { watchMessengerScript, view } = await mountReader();
    const script = injectSdkScript();

    watchMessengerScript();
    await fire(script, "error");

    expect(view.textContent).toBe("unreachable");
  });

  it("stays pending while the script is still in flight", async () => {
    const { watchMessengerScript, view } = await mountReader();
    injectSdkScript();

    watchMessengerScript();

    expect(view.textContent).toBe("pending");
  });

  it("picks up a script the SDK injects later, on readystatechange", async () => {
    const { watchMessengerScript, view } = await mountReader();

    // Nothing to watch yet: the SDK defers injection until the document is
    // ready, which streaming SSR can beat to the mount effect that calls us.
    watchMessengerScript();
    expect(view.textContent).toBe("pending");

    const script = injectSdkScript();
    await fire(document, "readystatechange");
    await fire(script, "load");

    expect(view.textContent).toBe("ready");
  });

  it("stays pending forever when no script is ever injected -- the integration is off", async () => {
    const { watchMessengerScript, view } = await mountReader();

    watchMessengerScript();
    await fire(document, "readystatechange");

    // The state a deployment with NEXT_PUBLIC_INTERCOM_APP_ID unset sits in for
    // the life of the page. Callers must read it as "no Messenger", which is
    // what keeps the mailto fallback correct there.
    expect(view.textContent).toBe("pending");
  });

  it("is idempotent, so the three boot paths in ./messenger can each call it", async () => {
    const { watchMessengerScript, view } = await mountReader();
    const script = injectSdkScript();

    watchMessengerScript();
    watchMessengerScript();
    watchMessengerScript();

    await fire(script, "load");

    expect(view.textContent).toBe("ready");
  });

  it("keeps the first verdict, so nothing later can revoke a Messenger that loaded", async () => {
    const { watchMessengerScript, view } = await mountReader();
    const script = injectSdkScript();
    watchMessengerScript();

    await fire(script, "load");
    // A script fires one or the other, never both, so this is about the state
    // being one-way by construction rather than about a path a browser takes.
    await fire(script, "error");
    watchMessengerScript();

    expect(view.textContent).toBe("ready");
  });

  it("keeps the first verdict the other way too -- a blocked widget stays blocked", async () => {
    const { watchMessengerScript, view } = await mountReader();
    const script = injectSdkScript();
    watchMessengerScript();

    await fire(script, "error");
    await fire(script, "load");

    expect(view.textContent).toBe("unreachable");
  });
});
