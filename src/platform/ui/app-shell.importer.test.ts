import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("AppShell single-importer invariant", () => {
  it("is imported only by the shared (app) layout", () => {
    // List every file under src/app that imports AppShell. Expect exactly one:
    // the shared route-group layout. Any other hit means a page/layout re-inlined
    // the shell, which reintroduces the cross-module remount this work removed.
    //
    // Test files are excluded because a test naming the module in vi.mock() is
    // the opposite of the thing this guards: it STUBS the shell out so an
    // unrelated unit test does not drag in its import chain, and stubbing cannot
    // reintroduce a remount. (app)/layout.test.tsx does exactly that. Without
    // this exclusion the invariant fires on the test that exists to test the very
    // layout it is protecting, which is a false positive that teaches people to
    // edit the invariant rather than believe it.
    const out = execSync(
      'grep -rl "ui/app-shell" src/app --exclude="*.test.ts" --exclude="*.test.tsx" || true',
      { encoding: "utf8" }
    ).trim();
    const files = out ? out.split("\n").sort() : [];
    expect(files).toEqual(["src/app/(app)/layout.tsx"]);
  });
});
