import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("AppShell single-importer invariant", () => {
  it("is imported only by the shared (app) layout", () => {
    // List every file under src/app that imports AppShell. Expect exactly one:
    // the shared route-group layout. Any other hit means a page/layout re-inlined
    // the shell, which reintroduces the cross-module remount this work removed.
    const out = execSync(
      "grep -rl \"ui/app-shell\" src/app || true",
      { encoding: "utf8" }
    ).trim();
    const files = out ? out.split("\n").sort() : [];
    expect(files).toEqual(["src/app/(app)/layout.tsx"]);
  });
});
