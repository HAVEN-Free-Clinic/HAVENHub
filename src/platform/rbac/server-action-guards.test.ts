/**
 * Static guard over inline `"use server"` closures (audit 14, TSI-03).
 *
 * 149 server actions are declared inline inside page components -- publish a
 * schedule, offboard a member, decide a strike, delete a cycle. Each one is a
 * POST endpoint Next.js exposes by action id, callable by anyone who can reach
 * the app, and the ONLY thing standing in front of it is the require* call in
 * its own first line. No test can reach them: they are not exported, so nothing
 * can import them, and a page render never executes their bodies.
 *
 * So check the source instead, in the style of the CRON_JOBS registry guard in
 * src/platform/cron-heartbeat.test.ts: walk the files, pull out every closure,
 * and require each to call one of the four session guards. This proves nothing
 * about whether a closure picked the RIGHT permission -- only that it asks. That
 * is still the difference between a missing check and a wrong one, and a missing
 * check is the failure that has actually happened here.
 *
 * At the time of writing: 149 closures, 140 with a visible guard, 9 exempt for
 * the reasons recorded in EXEMPT below. A new unguarded closure fails this test.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");

/**
 * The session guards. `can()` deliberately does NOT count: it returns a boolean,
 * so a closure that calls it without branching on the result is unguarded, and
 * every closure that uses it also calls a require* first anyway (verified when
 * this test was written -- allowing `can()` would have added zero coverage and
 * cost the ability to spot an unused check).
 */
const GUARD = /\brequire(PersonSession|Permission|AnyPermission|ModuleAccess)\s*\(/;

/** Only a directive on its own indented line: a file-level "use server" sits at column 0. */
const INLINE_DIRECTIVE = /^[ \t]+"use server";[ \t]*$/gm;

/**
 * Closures that legitimately run without a session check, with the reason and
 * the exact count per file so that ADDING an unguarded one still fails. Every
 * entry here is either pre-authentication (the caller has no session yet, which
 * is the point), a sign-out, or an intentional no-op.
 */
const EXEMPT: Record<string, { count: number; reason: string }> = {
  "src/app/login/page.tsx": {
    count: 1,
    reason: "dev-credentials sign-in: the caller has no session yet",
  },
  "src/app/login/verify/page.tsx": {
    count: 1,
    reason: "member magic-link sign-in; the token IS the credential",
  },
  "src/app/apply/verify/page.tsx": {
    count: 1,
    reason: "applicant magic-link confirm; the token IS the credential",
  },
  "src/app/welcome/page.tsx": { count: 1, reason: "sign out" },
  "src/app/get-started/page.tsx": { count: 1, reason: "sign out" },
  "src/platform/ui/app-shell.tsx": { count: 1, reason: "sign out (account menu)" },
  "src/app/(app)/notifications/page.tsx": {
    count: 1,
    reason:
      "delegates to markAllReadAction, which calls requirePersonSession itself " +
      "(src/platform/notifications/inbox-actions.ts)",
  },
  "src/app/(app)/schedule/builder/page.tsx": {
    count: 1,
    reason:
      "readOnlyGridAction: an empty no-op swapped in for an archived term so the " +
      "grid's cells post nothing at all",
  },
};

type Closure = { file: string; line: number; guarded: boolean };

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(p, out);
    // Inline actions only ever live in components, and a .test file that
    // mentioned the directive in a fixture string is not a real endpoint.
    else if (entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx")) out.push(p);
  }
  return out;
}

/** The body of the function whose first statement is the directive at `at`. */
function closureBody(source: string, at: number): string {
  const open = source.lastIndexOf("{", at);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(open, i + 1);
  }
  return source.slice(open);
}

function inlineServerActions(): Closure[] {
  const found: Closure[] = [];
  for (const file of sourceFiles(SRC)) {
    const source = readFileSync(file, "utf8");
    if (!source.includes('"use server"')) continue;
    // POSIX-style so the keys in EXEMPT read like the paths a developer types.
    const rel = relative(process.cwd(), file).split(sep).join("/");
    for (const m of source.matchAll(INLINE_DIRECTIVE)) {
      found.push({
        file: rel,
        line: source.slice(0, m.index).split("\n").length,
        guarded: GUARD.test(closureBody(source, m.index)),
      });
    }
  }
  return found;
}

describe("inline server actions check a permission", () => {
  const closures = inlineServerActions();

  it("finds the inline actions at all", () => {
    // A broken walk (renamed directory, changed directive spelling) would make
    // every assertion below vacuously true, which is the failure mode this
    // whole file exists to prevent.
    expect(closures.length).toBeGreaterThan(120);
  });

  it("has no unguarded closure outside the recorded exemptions", () => {
    const unguarded = closures.filter((c) => !c.guarded);
    const perFile = new Map<string, number[]>();
    for (const c of unguarded) perFile.set(c.file, [...(perFile.get(c.file) ?? []), c.line]);

    const offenders: string[] = [];
    for (const [file, lines] of perFile) {
      const allowed = EXEMPT[file]?.count ?? 0;
      if (lines.length > allowed) {
        offenders.push(
          `${file} has ${lines.length} unguarded "use server" closure(s) at line(s) ` +
            `${lines.join(", ")}, but only ${allowed} are exempt. Call requirePermission / ` +
            `requireModuleAccess / requirePersonSession as the closure's first statement, ` +
            `or add it to EXEMPT with the reason it needs no session.`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the exemption list honest (no stale entries)", () => {
    const unguardedPerFile = new Map<string, number>();
    for (const c of closures.filter((x) => !x.guarded)) {
      unguardedPerFile.set(c.file, (unguardedPerFile.get(c.file) ?? 0) + 1);
    }
    const stale = Object.entries(EXEMPT)
      .filter(([file, { count }]) => (unguardedPerFile.get(file) ?? 0) !== count)
      .map(([file, { count }]) => `${file}: exempts ${count}, found ${unguardedPerFile.get(file) ?? 0}`);
    // An exemption that no longer matches means the file was guarded, deleted or
    // renamed. Left in place it would silently license a future unguarded action.
    expect(stale).toEqual([]);
  });
});
