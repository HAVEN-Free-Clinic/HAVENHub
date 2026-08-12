import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("AppShell single-importer invariant", () => {
  it("is imported only by the shared (app) layout", () => {
    // List every file under src/app that imports AppShell. Expect exactly one:
    // the shared route-group layout. Any other hit means a page/layout re-inlined
    // the shell, which reintroduces the cross-module remount this work removed.
    //
    // Test files are excluded because the thing being guarded against is a
    // SHIPPED page or layout mounting a second shell. A test that stubs the
    // shell (vi.mock("@/platform/ui/app-shell")) is the opposite: it never
    // renders one, and it cannot cause a remount. Without this exclusion the
    // invariant fires on the test that exists to test the very layout it
    // protects, which teaches the next person to edit the invariant rather than
    // believe it.
    const out = execSync(
      'grep -rl "ui/app-shell" src/app --exclude="*.test.ts" --exclude="*.test.tsx" || true',
      { encoding: "utf8" }
    ).trim();
    const files = out ? out.split("\n").sort() : [];
    expect(files).toEqual(["src/app/(app)/layout.tsx"]);
  });
});
