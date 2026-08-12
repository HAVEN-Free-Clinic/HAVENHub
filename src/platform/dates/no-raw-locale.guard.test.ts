import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";

/**
 * Guards the Eastern Time migration: no display code may call the raw
 * date-only/time-only locale methods. All date rendering goes through
 * src/platform/dates. (Number .toLocaleString() is unaffected and allowed.)
 */
describe("no raw locale date formatting outside src/platform/dates", () => {
  it("has zero toLocaleDateString/toLocaleTimeString calls in app code", () => {
    const files = execSync(
      "git ls-files 'src/**/*.ts' 'src/**/*.tsx'",
      { encoding: "utf8" }
    )
      .split("\n")
      .filter(Boolean)
      .filter((f) => !f.startsWith("src/platform/dates/")) // the one allowed home
      .filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"));

    const offenders: string[] = [];
    for (const f of files) {
      // git ls-files reads the INDEX, not the working tree, so a file deleted
      // but not yet staged is still listed here. Skip anything that no longer
      // exists on disk: a deleted file has no code left to offend, and without
      // this the guard throws ENOENT mid-rename and reports as a date-format
      // failure, which is a confusing way to learn you have an unstaged delete.
      if (!existsSync(f)) continue;
      const src = readFileSync(f, "utf8");
      if (/\.toLocaleDateString\(|\.toLocaleTimeString\(/.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});
