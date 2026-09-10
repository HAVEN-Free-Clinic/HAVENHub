import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";

/**
 * `Tone` is the app's five-word vocabulary for status colour, and Badge owns it.
 *
 * Six files declared it independently -- badge, stat-card, recruitment's
 * status-badge and onboarding-table, support's status-badge and labels -- each
 * spelling out the same union by hand. Nothing broke while the five agreed,
 * which is the problem: a sixth tone added to Badge would compile everywhere and
 * simply be unreachable from five of the six, with no error to say so.
 *
 * A grep guard because the thing being guarded is that the union appears ONCE.
 * A type cannot assert its own uniqueness, and a structural lint rule would have
 * to know which file is allowed to be the declaration.
 */
function declarations(): string[] {
  try {
    return execSync(
      `grep -rn --include='*.ts' --include='*.tsx' -F ` +
        `'"default" | "brand" | "success" | "warning" | "critical"' src`,
      { encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(":")[0])
      // This file spells the union out to grep for it, which is the one place
      // it SHOULD still appear outside the declaration.
      .filter((file) => file !== "src/platform/ui/tone-union.guard.test.ts")
      .filter((file, i, all) => all.indexOf(file) === i);
  } catch {
    return []; // grep exits 1 on no matches
  }
}

describe("the Tone union", () => {
  it("is written out in exactly one file", () => {
    expect(declarations()).toEqual(["src/platform/ui/badge.tsx"]);
  });
});
