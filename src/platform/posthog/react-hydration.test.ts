import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { isRecoverableHydrationEvent } from "./react-hydration";

/**
 * Path to a react-dom client bundle. Resolved from the package root because
 * react-dom's `exports` map does not expose the `cjs/` subpath directly.
 */
function reactDomBundle(build: "production" | "development"): string {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve("react-dom/package.json"));
  return join(root, "cjs", `react-dom-client.${build}.js`);
}

/** The `$exception` shape posthog-js sends: the message lands in `value`. */
const exceptionEvent = (values: unknown[]) => ({
  event: "$exception",
  properties: {
    $exception_list: values.map((value) => ({ type: "Error", value })),
  },
});

/** React's production message for `code`, in the exact shape it builds. */
const minified = (code: number, arg = "HTML") =>
  `Minified React error #${code}; visit https://react.dev/errors/${code}?args[]=${arg}` +
  " for the full message or use the non-minified dev environment for full errors" +
  " and additional helpful warnings.";

/** The message production actually captured, from the PostHog event. */
const CAPTURED_418 = minified(418, "HTML");

describe("the format this filter parses", () => {
  it("is still how React builds a minified error", () => {
    // Pinned to the framework, not to our copy of the string: React owns this
    // template, so if it changes the wording or drops the code this fails here
    // rather than the filter quietly going dead and the duplicate tickets
    // coming back.
    const bundle = readFileSync(reactDomBundle("production"), "utf8");
    expect(
      bundle.includes('"Minified React error #" +'),
      "React no longer builds the minified message this filter parses -- re-derive it before trusting the filter",
    ).toBe(true);
    expect(bundle).toContain('url += "?args[]=" + encodeURIComponent(arguments[1]);');
  });

  it("still corresponds to a real hydration mismatch in React's dev build", () => {
    // The captured event carried args[]=HTML. React's dev bundle interpolates
    // exactly "text" or "HTML" into this message, which is what ties the
    // production code we filter to this failure mode.
    const dev = readFileSync(reactDomBundle("development"), "utf8");
    expect(dev).toContain("Hydration failed because the server rendered ");
    expect(dev).toContain('(fromText ? "text" : "HTML")');
  });
});

describe("isRecoverableHydrationEvent", () => {
  it("drops the mismatch production actually filed twice", () => {
    expect(isRecoverableHydrationEvent(exceptionEvent([CAPTURED_418]))).toBe(true);
  });

  it("drops the text-content variant too", () => {
    expect(isRecoverableHydrationEvent(exceptionEvent([minified(418, "text")]))).toBe(true);
    expect(isRecoverableHydrationEvent(exceptionEvent([minified(425)]))).toBe(true);
  });

  it("reads the code from the errors URL when the message is not minified", () => {
    expect(
      isRecoverableHydrationEvent(
        exceptionEvent([
          "Hydration failed because the server rendered HTML didn't match the client. " +
            "See https://react.dev/errors/418 for more information.",
        ]),
      ),
    ).toBe(true);
  });

  it("KEEPS the hydration codes that mean something actually threw", () => {
    // #421/#422/#423 are "an error occurred while hydrating, so React switched to
    // client rendering". The underlying throw is a real bug and must stay visible;
    // filtering this family is the mistake this test exists to prevent.
    for (const code of [421, 422, 423]) {
      expect(
        isRecoverableHydrationEvent(exceptionEvent([minified(code)])),
        `React error #${code} must not be filtered`,
      ).toBe(false);
    }
  });

  it("keeps ordinary client errors", () => {
    expect(isRecoverableHydrationEvent(exceptionEvent(["boom"]))).toBe(false);
    expect(isRecoverableHydrationEvent(exceptionEvent(["x is not a function"]))).toBe(false);
    // A React error that is not a hydration mismatch stays too.
    expect(isRecoverableHydrationEvent(exceptionEvent([minified(300)]))).toBe(false);
  });

  it("keeps an exception that mixes a mismatch with a real error", () => {
    // The real error is the signal, matching the sibling filters.
    expect(isRecoverableHydrationEvent(exceptionEvent([CAPTURED_418, "boom"]))).toBe(false);
  });

  it("ignores non-exception events and malformed payloads", () => {
    expect(isRecoverableHydrationEvent(null)).toBe(false);
    expect(isRecoverableHydrationEvent({ event: "$pageview" })).toBe(false);
    expect(isRecoverableHydrationEvent(exceptionEvent([]))).toBe(false);
    expect(
      isRecoverableHydrationEvent({ event: "$exception", properties: { $exception_list: "nope" } }),
    ).toBe(false);
    expect(isRecoverableHydrationEvent(exceptionEvent([null, undefined, 42]))).toBe(false);
  });
});
