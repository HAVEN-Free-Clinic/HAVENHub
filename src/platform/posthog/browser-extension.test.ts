/**
 * Tests for the browser-extension exception filter.
 *
 * The load-bearing half is the NEGATIVE cases: a filter on the error-reporting
 * path fails silently, so the tests that matter are the ones proving it does not
 * eat our own exceptions.
 */

import { describe, expect, it } from "vitest";
import { isBrowserExtensionEvent } from "./browser-extension";

const exceptionEvent = (list: unknown) => ({
  event: "$exception",
  properties: { $exception_list: list },
});

const frame = (filename: string) => ({ filename, function: "doThing", in_app: false });

describe("isBrowserExtensionEvent", () => {
  // The real capture that motivated this: an extension talking to its own dead
  // background worker, delivered with the stack stripped.
  it("drops a stackless Zotero Connector message", () => {
    expect(
      isBrowserExtensionEvent(
        exceptionEvent([
          {
            type: "Error",
            value:
              "Zotero Connector: Failed to send message i18n.getStrings to background page. It may be dead.",
          },
        ]),
      ),
    ).toBe(true);
  });

  it.each([
    ["chrome-extension://", "chrome-extension://abcdefg/content.js"],
    ["moz-extension://", "moz-extension://1234-5678/inject.js"],
    ["safari-web-extension://", "safari-web-extension://ABCD/script.js"],
  ])("drops an exception whose stack contains a %s frame", (_scheme, filename) => {
    expect(
      isBrowserExtensionEvent(
        exceptionEvent([
          { type: "TypeError", value: "x is not a function", stacktrace: { frames: [frame(filename)] } },
        ]),
      ),
    ).toBe(true);
  });

  // Extensions monkey-patch fetch and XHR, so a genuine bug of ours can carry an
  // extension frame. Dropping on that would silently delete real errors, so a
  // mixed stack is kept.
  it("keeps an exception whose stack mixes our code with an extension frame", () => {
    expect(
      isBrowserExtensionEvent(
        exceptionEvent([
          {
            type: "TypeError",
            value: "boom",
            stacktrace: {
              frames: [
                frame("https://hub.havenfreeclinic.org/_next/static/chunk.js"),
                frame("chrome-extension://abc/c.js"),
              ],
            },
          },
        ]),
      ),
    ).toBe(false);
  });

  // --- Everything below must be KEPT ---

  it("keeps an ordinary application exception", () => {
    expect(
      isBrowserExtensionEvent(
        exceptionEvent([
          {
            type: "TypeError",
            value: "Cannot read properties of undefined (reading 'id')",
            stacktrace: { frames: [frame("https://hub.havenfreeclinic.org/_next/static/chunk.js")] },
          },
        ]),
      ),
    ).toBe(false);
  });

  it("keeps an exception with no stack and no extension marker", () => {
    expect(isBrowserExtensionEvent(exceptionEvent([{ type: "Error", value: "Script error." }]))).toBe(
      false,
    );
  });

  // The mixed case: dropping this would lose a real defect because an unrelated
  // extension happened to throw in the same batch.
  it("keeps a batch that mixes an extension error with one of ours", () => {
    expect(
      isBrowserExtensionEvent(
        exceptionEvent([
          { type: "Error", value: "Zotero Connector: Failed to send message" },
          {
            type: "TypeError",
            value: "our real bug",
            stacktrace: { frames: [frame("https://hub.havenfreeclinic.org/_next/static/chunk.js")] },
          },
        ]),
      ),
    ).toBe(false);
  });

  it("keeps an application error that merely mentions an extension scheme in its text", () => {
    expect(
      isBrowserExtensionEvent(
        exceptionEvent([
          {
            type: "Error",
            value: "Refused to load chrome-extension://abc because of our CSP",
            stacktrace: { frames: [frame("https://hub.havenfreeclinic.org/_next/static/chunk.js")] },
          },
        ]),
      ),
    ).toBe(false);
  });

  it("ignores non-exception events and empty input", () => {
    expect(isBrowserExtensionEvent(null)).toBe(false);
    expect(isBrowserExtensionEvent({ event: "$pageview" })).toBe(false);
    expect(isBrowserExtensionEvent(exceptionEvent([]))).toBe(false);
    expect(isBrowserExtensionEvent(exceptionEvent("not-an-array"))).toBe(false);
  });
});
