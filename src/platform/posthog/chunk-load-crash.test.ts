import { describe, expect, it } from "vitest";

import {
  decideChunkLoadRecovery,
  isChunkLoadError,
} from "./chunk-load-crash";

/**
 * The exact message production captured, copied from the real PostHog event
 * (issue #677, 2026-08-27). Turbopack is our production bundler; its runtime
 * lives in Next's native binary, not in a shipped JS file, so there is no bundle
 * to pin the wording against the way router-hook-crash.test.ts pins React.
 */
const TURBOPACK_MESSAGE =
  "Failed to load chunk /_next/static/chunks/0h8agk608i087.js from module 964893";

/** webpack's shape, for the build that falls back off Turbopack. */
const WEBPACK_MESSAGE = "Loading chunk 42 failed.\n(missing: /_next/static/chunks/42.js)";

describe("isChunkLoadError", () => {
  it("matches the Turbopack message production actually captured", () => {
    // Turbopack throws a plain Error, so `name` is "Error"; only the message tells.
    expect(isChunkLoadError(new Error(TURBOPACK_MESSAGE))).toBe(true);
  });

  it("matches a bare string, as a cross-origin error event delivers it", () => {
    // event.error is null there, leaving only the browser-prefixed message.
    expect(isChunkLoadError(`Uncaught Error: ${TURBOPACK_MESSAGE}`)).toBe(true);
  });

  it("matches webpack's ChunkLoadError by name", () => {
    const error = Object.assign(new Error(WEBPACK_MESSAGE), {
      name: "ChunkLoadError",
    });
    expect(isChunkLoadError(error)).toBe(true);
  });

  it("matches webpack's message even without the name", () => {
    expect(isChunkLoadError(new Error(WEBPACK_MESSAGE))).toBe(true);
  });

  it("does not match ordinary app errors", () => {
    expect(isChunkLoadError(new Error("boom"))).toBe(false);
    expect(isChunkLoadError(new TypeError("x is not a function"))).toBe(false);
  });

  it("handles non-object throws", () => {
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
    expect(isChunkLoadError(964893)).toBe(false);
  });
});

describe("decideChunkLoadRecovery", () => {
  it("reloads on the first chunk-load failure in a tab", () => {
    expect(decideChunkLoadRecovery(new Error(TURBOPACK_MESSAGE), false)).toBe(
      "reload",
    );
  });

  it("refuses a second reload in the same tab", () => {
    // A failure that survives the reload is not the transient drop this is for,
    // and reloading again would loop.
    expect(decideChunkLoadRecovery(new Error(TURBOPACK_MESSAGE), true)).toBe(
      "already-recovered",
    );
  });

  it("leaves every other error alone", () => {
    expect(decideChunkLoadRecovery(new Error("boom"), false)).toBe("unrelated");
  });
});
