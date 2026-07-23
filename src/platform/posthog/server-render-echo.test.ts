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

describe("isServerRenderEchoError", () => {
  it("matches the scrubbed message React ships in the flight client", () => {
    // Pinned to the framework rather than to our copy of the string: React owns
    // this wording, so if it rewords the scrubbing this fails instead of the
    // filter quietly going dead and the echo issue coming back.
    const require = createRequire(import.meta.url);
    const flightClient = require.resolve(
      "next/dist/compiled/react-server-dom-turbopack/cjs/react-server-dom-turbopack-client.browser.production.js",
    );
    const shipped = readFileSync(flightClient, "utf8").match(
      /An error occurred in the Server[^"']{0,300}/,
    )?.[0];

    expect(
      shipped,
      "React no longer ships the scrubbed server-render message this filter matches -- re-derive it before trusting the filter",
    ).toBeTruthy();
    expect(isServerRenderEchoError(new Error(shipped!))).toBe(true);
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
