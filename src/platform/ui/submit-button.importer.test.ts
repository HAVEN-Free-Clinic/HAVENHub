import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * SubmitButton exists once, and every form imports that one.
 *
 * /outreach/campaigns/[id] carried its own 24-line copy: same name, same
 * useFormStatus, but no <Spinner> and no aria-busy. So eight submits in the
 * campaign flow (Save, Send test to me, Schedule, Start now, Exclude, Restore,
 * Add, Save recipients) went flat-disabled with a swapped label while Create,
 * one route earlier, spun. A fork of a shared control is invisible at the call
 * site: all eight of those call sites read exactly like every other
 * <SubmitButton> in the app.
 *
 * Test files are excluded because what is being guarded against is a SHIPPED
 * form re-declaring or re-importing a local SubmitButton. A test that names the
 * component in a string (this file does, twice, inside the grep patterns below)
 * ships nothing to a user; without the exclusion this invariant would match its
 * own source and fail forever, which teaches the next person to edit the guard
 * rather than believe it.
 *
 * Narrowing a grep is how a guard quietly stops guarding, so both greps were
 * probed: a throwaway src/modules/probe-form.tsx that declares and imports its
 * own SubmitButton still fails both assertions below, listed by name.
 */
describe("SubmitButton single-definition invariant", () => {
  const EXCLUDES = '--exclude="*.test.ts" --exclude="*.test.tsx"';

  it("is declared in exactly one place", () => {
    const out = execSync(`grep -rln "export function SubmitButton" src ${EXCLUDES} || true`, {
      encoding: "utf8",
    }).trim();
    const files = out ? out.split("\n").sort() : [];
    expect(files).toEqual(["src/platform/ui/submit-button.tsx"]);
  });

  it("is only ever imported from the platform path", () => {
    const out = execSync(`grep -rn "import { SubmitButton }" src ${EXCLUDES} || true`, {
      encoding: "utf8",
    }).trim();
    const lines = out ? out.split("\n") : [];
    // A guard that passes on an empty result is not a guard: if the grep ever
    // stops matching (a rename, a moved directory) this fails loudly instead of
    // reporting a clean tree.
    expect(lines.length).toBeGreaterThan(20);
    const strays = lines.filter((l) => !l.includes('"@/platform/ui/submit-button"'));
    expect(strays).toEqual([]);
  });
});
