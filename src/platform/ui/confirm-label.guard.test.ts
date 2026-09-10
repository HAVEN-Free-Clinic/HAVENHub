import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";

/**
 * Guards what the armed step of a ConfirmButton says.
 *
 * `confirmLabel` is a required prop, so tsc already stops a call site omitting
 * it. What tsc cannot stop is a call site typing the old default back in:
 * `confirmLabel="Confirm?"` names nothing, and the aria-live region announces
 * it with no object, which is exactly the state this guard exists to end.
 *
 * The question-mark half is not cosmetic. Four e2e specs (volunteers :31 and
 * :163, incidents :103, term-transition :80) find the armed button by filtering
 * the row's buttons on a question mark, because the idle label never has one. A
 * confirmLabel without one makes that locator match nothing and the spec hangs
 * rather than failing cleanly.
 *
 * Only string literals are checked. Several call sites build the label from
 * data (admin/terms/[id]/page.tsx, delivery-log-table.tsx, the template-literal
 * sites); those are the author's problem, not this regex's.
 */
describe("every literal confirmLabel names what is about to happen", () => {
  it("has no bare Confirm? and no confirmLabel missing its question mark", () => {
    const files = execSync("git ls-files 'src/**/*.tsx'", { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      // The primitive's own test uses "Confirm?" as its fixture label, which is
      // the one place the string is not a caller naming nothing.
      .filter((f) => f !== "src/platform/ui/confirm-button.test.tsx");

    const offenders: string[] = [];
    for (const f of files) {
      // git ls-files reads the index, so a staged-but-deleted file is listed.
      if (!existsSync(f)) continue;
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/confirmLabel="([^"]*)"/g)) {
        const value = m[1];
        if (value === "Confirm?") {
          offenders.push(`${f}: bare "Confirm?" names nothing`);
        } else if (!value.includes("?")) {
          offenders.push(`${f}: "${value}" has no question mark`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
