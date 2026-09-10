import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * The regression bar for the shared assigned-course card, and the only
 * assertion here that fails for the reason a member would notice.
 *
 * The residue of this finding was that /get-started/learning never printed
 * "Retake each term", while /learning, closed to that member until they clear
 * the gate, did. Carrying `recurrence` on MyCourseRow is a necessary step, and
 * enrollment.test.ts pins it, but it is only a step: someone could land that
 * service change alone and never open the onboarding page, and every unit test
 * in the module would still pass. These two greps do not.
 *
 * Test files are excluded for the reason app-shell.importer.test.ts spells out,
 * and this file lives under src/modules rather than src/app so it cannot match
 * its own source. Probed: a throwaway third page under src/app rendering the
 * card fails the first assertion by name, and pasting either page's old
 * `const LABEL = {` back fails the second.
 */
describe("assigned-course card is the only assigned-course list row", () => {
  const EXCLUDES = '--exclude="*.test.ts" --exclude="*.test.tsx"';

  it("is rendered by both learner course lists and nowhere else", () => {
    const out = execSync(`grep -rl "AssignedCourseCard" src/app ${EXCLUDES} || true`, {
      encoding: "utf8",
    }).trim();
    expect(out ? out.split("\n").sort() : []).toEqual([
      "src/app/(app)/learning/page.tsx",
      "src/app/get-started/learning/page.tsx",
    ]);
  });

  it("leaves no page-local status label map behind", () => {
    // Both pages declared the same three-key map. Two copies of a label map one
    // nav hop apart is how "In progress" becomes "In Progress" on one page only.
    const out = execSync(
      `grep -rn "const LABEL = {" src/app/\\(app\\)/learning src/app/get-started/learning ${EXCLUDES} || true`,
      { encoding: "utf8" },
    ).trim();
    expect(out).toBe("");
  });
});
