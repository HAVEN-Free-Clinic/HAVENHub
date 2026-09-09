import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  isServerRenderEchoError,
  isServerRenderEchoEvent,
} from "./server-render-echo";

/** The exact message production captured, copied from a real PostHog event. */
const SCRUBBED_MESSAGE =
  "An error occurred in the Server Components render. The specific message is " +
  "omitted in production builds to avoid leaking sensitive details. A digest " +
  "property is included on this error instance which may provide additional " +
  "details about the nature of the error.";

/** The `$exception` shape posthog-js sends: the message lands in `value`. */
const exceptionEvent = (values: unknown[]) => ({
  event: "$exception",
  properties: {
    $exception_list: values.map((value) => ({ type: "Error", value })),
  },
});

/**
 * What React's `resolveErrorProd` actually constructs in one shipped bundle.
 *
 * Read from the file rather than trusted from memory, because this is the whole
 * point of these two tests: next 16.2.11 -> 16.3.4 switched the BROWSER bundle
 * from the prose to a minified code, and matching only the prose would have left
 * the filter dead in the exact place it runs.
 */
function shippedEchoMessage(runtime: "browser" | "node"): string | undefined {
  const require = createRequire(import.meta.url);
  const src = readFileSync(
    require.resolve(
      `next/dist/compiled/react-server-dom-turbopack/cjs/react-server-dom-turbopack-client.${runtime}.production.js`,
    ),
    "utf8",
  );
  const body = src.slice(src.indexOf("function resolveErrorProd"));
  const prose = body.match(/An error occurred in the Server[^"']{0,300}/)?.[0];
  if (prose) return prose;
  // Minified form: Error(formatProdErrorMessage(441)). Rebuild what that
  // returns, from the code in the file, so a renumber is caught.
  const code = body.match(/formatProdErrorMessage\((\d+)\)/)?.[1];
  if (!code) return undefined;
  return (
    `Minified React error #${code}; visit https://react.dev/errors/${code}` +
    " for the full message or use the non-minified dev environment for full" +
    " errors and additional helpful warnings."
  );
}

describe("isServerRenderEchoError", () => {
  it("matches what the BROWSER flight client throws, which is where this runs", () => {
    // Both capture paths are client-side, so this bundle is the one that
    // matters. next 16.3 minified it; on 16.2.11 it carried the prose.
    const shipped = shippedEchoMessage("browser");
    expect(
      shipped,
      "Could not read resolveErrorProd out of React's browser flight client -- re-derive the marker before trusting the filter",
    ).toBeTruthy();
    expect(isServerRenderEchoError(new Error(shipped!))).toBe(true);
  });

  it("still matches what the SSR flight client throws, which kept the prose", () => {
    // node/edge did NOT change in 16.3, and an echo can still reach a client
    // capture path with the prose (a cached older bundle mid-rollout).
    const shipped = shippedEchoMessage("node");
    expect(shipped).toBeTruthy();
    expect(shipped).toContain("An error occurred in the Server");
    expect(isServerRenderEchoError(new Error(shipped!))).toBe(true);
  });

  it("does not drop every minified React error, only this one", () => {
    // The generic "Minified React error #" prefix would swallow real
    // client-side React failures, which is the opposite of the point.
    expect(
      isServerRenderEchoError(
        new Error(
          "Minified React error #418; visit https://react.dev/errors/418 for the full message or use the non-minified dev environment for full errors and additional helpful warnings.",
        ),
      ),
    ).toBe(false);
  });

  it("matches the message production actually captured", () => {
    expect(isServerRenderEchoError(new Error(SCRUBBED_MESSAGE))).toBe(true);
  });

  it("matches when the echo carries its digest, as an error boundary sees it", () => {
    const error = Object.assign(new Error(SCRUBBED_MESSAGE), {
      digest: "1985439387",
    });
    expect(isServerRenderEchoError(error)).toBe(true);
  });

  it("does not match a real client error", () => {
    expect(isServerRenderEchoError(new Error("boom"))).toBe(false);
    expect(
      isServerRenderEchoError(new TypeError("x is not a function")),
    ).toBe(false);
  });

  it("does not match an app error that merely mentions the server render", () => {
    expect(
      isServerRenderEchoError(
        new Error("An error occurred in the Server Components render helper"),
      ),
    ).toBe(false);
  });

  it("handles non-object throws", () => {
    expect(isServerRenderEchoError(null)).toBe(false);
    expect(isServerRenderEchoError(undefined)).toBe(false);
    expect(isServerRenderEchoError(SCRUBBED_MESSAGE)).toBe(false);
  });
});

describe("isServerRenderEchoEvent", () => {
  it("drops the $exception posthog-js builds from the echo", () => {
    expect(isServerRenderEchoEvent(exceptionEvent([SCRUBBED_MESSAGE]))).toBe(
      true,
    );
  });

  it("keeps a genuine exception", () => {
    expect(
      isServerRenderEchoEvent(exceptionEvent(["TypeError: x is undefined"])),
    ).toBe(false);
  });

  it("keeps an exception that mixes the echo with a real error", () => {
    // The real error is the signal; only an all-echo event is pure noise.
    expect(
      isServerRenderEchoEvent(exceptionEvent([SCRUBBED_MESSAGE, "real boom"])),
    ).toBe(false);
  });

  it("ignores events that are not exceptions", () => {
    expect(
      isServerRenderEchoEvent({ event: "$pageview", properties: {} }),
    ).toBe(false);
  });

  it("ignores an exception with no usable exception list", () => {
    expect(isServerRenderEchoEvent(exceptionEvent([]))).toBe(false);
    expect(
      isServerRenderEchoEvent({
        event: "$exception",
        properties: { $exception_list: "not a list" },
      }),
    ).toBe(false);
    expect(isServerRenderEchoEvent({ event: "$exception" })).toBe(false);
  });

  it("handles a null event", () => {
    expect(isServerRenderEchoEvent(null)).toBe(false);
  });
});
