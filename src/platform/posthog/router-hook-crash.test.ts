import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  decideCrashRecovery,
  isHookListExhaustedError,
} from "./router-hook-crash";

/**
 * The exact message production captured, copied from a real PostHog event
 * (issue 019fa512-2f04-71f3-bbe3-f5095eefb12d, 2026-07-27).
 */
const CAPTURED_MESSAGE =
  "Minified React error #310; visit https://react.dev/errors/310 for the full " +
  "message or use the non-minified dev environment for full errors and " +
  "additional helpful warnings.";

const require = createRequire(import.meta.url);

/**
 * The React that actually runs in the browser. Next aliases react-dom to its
 * own vendored copy for the App Router browser layer (`createVendoredReactAliases`
 * on WEBPACK_LAYERS.appPagesBrowser), so the versions in package.json are NOT
 * what throws this error -- these bundles are.
 */
function vendoredReactDom(build: "production" | "development"): string {
  return readFileSync(
    require.resolve(
      `next/dist/compiled/react-dom/cjs/react-dom-client.${build}.js`,
    ),
    "utf8",
  );
}

describe("isHookListExhaustedError", () => {
  it("matches the message production actually captured", () => {
    expect(isHookListExhaustedError(new Error(CAPTURED_MESSAGE))).toBe(true);
  });

  it("matches a bare string, as a cross-origin error event delivers it", () => {
    // event.error is null there, leaving only the browser-prefixed message.
    expect(
      isHookListExhaustedError(`Uncaught Error: ${CAPTURED_MESSAGE}`),
    ).toBe(true);
  });

  it("matches the minified codes React still ships", () => {
    // Pinned to the framework rather than to our copy of the numbers: React
    // renumbers its error codes, and a renumbering must fail here rather than
    // leave the recovery silently matching nothing.
    const shipped = vendoredReactDom("production");
    for (const code of [310, 467]) {
      expect(
        shipped.includes(`formatProdErrorMessage(${code})`),
        `React no longer throws minified error #${code} -- re-derive the codes before trusting the recovery`,
      ).toBe(true);
      expect(
        isHookListExhaustedError(
          new Error(
            `Minified React error #${code}; visit https://react.dev/errors/${code} for the full message`,
          ),
        ),
      ).toBe(true);
    }
  });

  it("matches the development wording React still ships", () => {
    const shipped = vendoredReactDom("development");
    for (const message of [
      "Rendered more hooks than during the previous render.",
      "Update hook called on initial render.",
    ]) {
      expect(
        shipped.includes(message),
        `React reworded "${message}" -- re-derive it before trusting the recovery`,
      ).toBe(true);
      expect(isHookListExhaustedError(new Error(message))).toBe(true);
    }
  });

  it("does not match other React errors or ordinary app errors", () => {
    expect(
      isHookListExhaustedError(
        new Error("Minified React error #300; visit https://react.dev/errors/300"),
      ),
    ).toBe(false);
    expect(isHookListExhaustedError(new Error("boom"))).toBe(false);
    expect(
      isHookListExhaustedError(new TypeError("x is not a function")),
    ).toBe(false);
  });

  it("handles non-object throws", () => {
    expect(isHookListExhaustedError(null)).toBe(false);
    expect(isHookListExhaustedError(undefined)).toBe(false);
    expect(isHookListExhaustedError(310)).toBe(false);
  });
});

describe("decideCrashRecovery", () => {
  it("reloads on the first hook-corruption crash in a tab", () => {
    expect(decideCrashRecovery(new Error(CAPTURED_MESSAGE), false)).toBe(
      "reload",
    );
  });

  it("refuses a second reload in the same tab", () => {
    // A crash that survives the reload is not the transient race this is for,
    // and reloading again would loop.
    expect(decideCrashRecovery(new Error(CAPTURED_MESSAGE), true)).toBe(
      "already-recovered",
    );
  });

  it("leaves every other error alone", () => {
    expect(decideCrashRecovery(new Error("boom"), false)).toBe("unrelated");
  });
});

describe("the upstream bug this works around", () => {
  it("is still unfixed in the React that Next ships", () => {
    // facebook/react#36911 ("Fix: Treat incomplete tree as an error during
    // recovery", merged 2026-06-30) is what actually fixes this: it stops
    // recoverFromConcurrentError committing a tree that unwound to the shell,
    // which is how Next's Router ends up current with a truncated hook list.
    // Next 16.2.11 and 16.2.12 vendor 19.3.0-canary-3f0b9e61-20260317, which
    // predates it.
    //
    // When this fails, a `next` upgrade has brought the fix in: delete
    // router-hook-crash.ts, router-crash-recovery.tsx, this test, and the mount
    // in src/app/layout.tsx.
    const hasFix =
      /!==\s*RootErrored\s*&&\s*[A-Za-z$_][\w$]*\s*!==\s*RootSuspendedAtTheShell/.test(
        vendoredReactDom("development"),
      );
    expect(
      hasFix,
      "Next now ships a React containing facebook/react#36911 -- remove the router crash recovery workaround",
    ).toBe(false);
  });
});
