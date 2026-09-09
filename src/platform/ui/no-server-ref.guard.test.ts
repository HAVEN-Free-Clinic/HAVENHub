import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";

/**
 * A module without "use client" may not create a ref of its own.
 *
 * THE FAILURE THIS EXISTS FOR. React refuses a ref in server-rendered output:
 *
 *   Error: Refs cannot be used in Server Components, nor passed to Client
 *   Components.
 *
 * `Checkbox` grew an `indeterminate` prop, which is a DOM property and so needs
 * a ref to set. It was written as a callback ref in a file with no "use client",
 * on the reasoning that a callback ref is not a hook. The premise is true; the
 * conclusion is not. Every server component rendering a checkbox threw on
 * render -- /, /admin/roles, /admin/terms, /admin/settings, /clinic,
 * /incidents/strikes -- and fell back to client rendering.
 *
 * It reached main because NOTHING SHORT OF E2E COULD SEE IT. tsc, eslint and the
 * whole vitest suite are green on that code: jsdom renders everything as a
 * client, so a unit test can never reach the RSC constraint. `next build` misses
 * it too, because these pages are auth-gated and dynamic, so none is prerendered.
 * The e2e suite caught it, one merge too late. This test is the cheap layer that
 * runs alongside the others.
 *
 * WHAT IT ALLOWS, and the distinction is the whole design. Accepting a ref from
 * a caller and attaching it is FINE, and `TabRow` does exactly that with its
 * optional `navRef`: a server caller passes nothing, React sees
 * `ref={undefined}` and is happy, and a client caller gets a working ref. That
 * pattern is how a server-renderable primitive lets a client consumer reach the
 * DOM node, and banning it would cost real ground for nothing.
 *
 * What is banned is a module CREATING one -- an inline `ref={(el) => ...}` or a
 * `useRef` -- because that fires on every render including a server one,
 * whatever the caller does. A component needing that belongs behind
 * "use client", the way ./checkbox-indeterminate now is.
 */
/**
 * Whether a file actually CARRIES the directive, as opposed to merely
 * mentioning it.
 *
 * Searching the first few hundred characters for the string is the obvious
 * implementation and it is wrong, which this guard learned about itself: this
 * very rule's client component opens with a doc comment reading `isolated
 * behind "use client"`, so a substring check excused the one file the rule
 * exists to constrain. That is the same confusion as the bug being guarded --
 * a comment about a directive is not a directive -- so it is worth the twelve
 * lines to get right.
 *
 * The directive must be the first STATEMENT, though comments may precede it, so
 * leading comments and whitespace are stripped and the remainder must BEGIN
 * with the literal.
 */
function hasUseClientDirective(src: string): boolean {
  let rest = src;
  for (;;) {
    const before = rest;
    rest = rest.replace(/^\s+/, "");
    rest = rest.replace(/^\/\*[\s\S]*?\*\//, "");
    rest = rest.replace(/^\/\/[^\n]*/, "");
    if (rest === before) break;
  }
  return rest.startsWith('"use client"') || rest.startsWith("'use client'");
}

describe("no self-created refs outside client components", () => {
  it("has no inline callback ref or useRef in a module without \"use client\"", () => {
    // --others --exclude-standard alongside --cached, so a file that has not
    // been staged yet is scanned too. Without it this guard is blind to exactly
    // the change most likely to trip it: a NEW component, still untracked, on
    // the branch that introduces it. Verified the hard way -- the first cut of
    // this test passed against a deliberately broken new file for that reason.
    // --exclude-standard keeps .gitignore honoured, so node_modules and the
    // gitignored design-system directory stay out (see the eslint note in
    // lint-purity docs about walking that directory).
    const files = execSync(
      "git ls-files --cached --others --exclude-standard 'src/**/*.tsx'",
      { encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean)
      .filter((f) => !f.includes(".test."));

    const offenders: string[] = [];
    for (const f of files) {
      // git ls-files reads the INDEX, so a file deleted but not yet staged is
      // still listed. Skip anything gone from disk, matching the reasoning in
      // dates/no-raw-locale.guard.test.ts: a deleted file has no code to offend,
      // and without this the guard throws ENOENT mid-rename and reports it as a
      // ref violation.
      if (!existsSync(f)) continue;
      const src = readFileSync(f, "utf8");
      if (hasUseClientDirective(src)) continue;
      // `ref={(` is an inline callback ref. `useRef(` is the hook. Both are the
      // module making its own ref; `ref={navRef}` forwarding a prop is not, and
      // deliberately does not match.
      if (/ref=\{\s*\(/.test(src) || /\buseRef\s*\(/.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});
