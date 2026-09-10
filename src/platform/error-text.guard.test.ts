import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { SHARED_ERROR_TEXT } from "./error-text";

/**
 * Keeps the shared refusal sentences in one place.
 *
 * Before src/platform/error-text.ts these two sentences existed as three
 * independent literals across the copy layer (the flash toast table plus the
 * ERROR_MESSAGES dictionaries on /incidents/new and /incidents/strikes), and
 * the coupling was documented in a flash.ts doc paragraph rather than encoded.
 * This guard fails on any fourth copy.
 *
 * Scoped to the copy layer (src/app and src/platform/ui) on purpose.
 * src/modules is excluded because a thrown Error's default message is not UI
 * copy: src/modules/incidents/services/report.ts keeps its own
 * `IncidentForbiddenError` default, which no user ever sees (every catch site
 * redirects with the `forbidden` CODE, never `err.message`), and binding it to
 * a toast string would mean a copy edit silently rewriting a domain
 * exception. Tests are excluded too: flash.test.ts deliberately holds these
 * sentences as hardcoded literals, which is what makes it the value guard on
 * the constant.
 *
 * One accepted friction: this also refuses the sentences inside a comment in a
 * scoped file. There are none today; quote the constant name instead.
 */
describe("shared refusal copy lives in SHARED_ERROR_TEXT", () => {
  it("has no second literal copy of a shared sentence in the copy layer", () => {
    const files = execSync("git ls-files 'src/**/*.ts' 'src/**/*.tsx'", { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .filter((f) => f.startsWith("src/app/") || f.startsWith("src/platform/ui/"))
      .filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"));

    const sentences = Object.values(SHARED_ERROR_TEXT);
    const offenders: string[] = [];
    for (const f of files) {
      // git ls-files reads the INDEX, so a file deleted but not yet staged is
      // still listed. Skip anything gone from disk rather than throwing ENOENT
      // and reporting an unstaged delete as a copy-drift failure.
      if (!existsSync(f)) continue;
      const src = readFileSync(f, "utf8");
      if (sentences.some((s) => src.includes(s))) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});
