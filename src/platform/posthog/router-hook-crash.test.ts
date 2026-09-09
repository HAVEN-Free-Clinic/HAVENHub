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
  it("is FIXED in the React that Next ships, so this module is now dead code", () => {
    // The tripwire fired. facebook/react#36911 ("Fix: Treat incomplete tree as
    // an error during recovery", merged 2026-06-30) stops
    // recoverFromConcurrentError committing a tree that unwound to the shell,
    // which is how Next's Router ended up current with a truncated hook list.
    //
    // next 16.2.11 vendored 19.3.0-canary-3f0b9e61-20260317 (2026-03-17), which
    // predates it. The 16.3.4 security upgrade brought
    // 19.3.0-canary-cbb046ab-20260731, which has it -- the retry path now reads
    // `!== RootErrored && ... !== RootSuspendedAtTheShell`.
    //
    // The assertion is inverted rather than deleted so that a `next` DOWNGRADE,
    // or a vendored-React rollback, fails here instead of silently leaving the
    // app unprotected against a crash that kills the whole client.
    //
    // Removing the workaround itself is deliberately NOT part of the security
    // upgrade: router-hook-crash.ts also exports the shared `CrashRecovery`
    // type that four other self-heal modules import, and unmounting a recovery
    // path from the root layout should be reviewed on its own.
    const hasFix =
      /!==\s*RootErrored\s*&&\s*[A-Za-z$_][\w$]*\s*!==\s*RootSuspendedAtTheShell/.test(
        vendoredReactDom("development"),
      );
    expect(
      hasFix,
      "Next has gone BACK to a React without facebook/react#36911 -- the router crash recovery workaround is load-bearing again",
    ).toBe(true);
  });
});
