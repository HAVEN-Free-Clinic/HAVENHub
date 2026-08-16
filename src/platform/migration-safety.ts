/**
 * Which migration shapes are unsafe to ship in a SINGLE release, given how this
 * app deploys (audit 14, DM-2).
 *
 * vercel.json sets `buildCommand: "prisma migrate deploy && next build"`, so
 * every migration lands on the production database at the START of the build,
 * minutes before the new code is promoted. For that whole window the PREVIOUS
 * deployment is serving traffic against the NEW schema. docs/DEPLOY.md calls
 * this out and gives the expand/contract rule for dropped columns, which is the
 * shape that has actually bitten us twice (#597/#598, and the seven TechRequest
 * columns before that). But a dropped column is not the only shape that breaks
 * the old code, and nothing enforced the rule -- the runbook was a paragraph a
 * reviewer had to remember.
 *
 * This module is the enforcement half: a pure detector over migration SQL, used
 * by migration-safety.test.ts, which walks prisma/migrations in CI. It is
 * deliberately dependency-free (no fs, no Prisma) so it can be unit-tested
 * against literal SQL and reused by any script.
 *
 * The shapes, and what each does to the deployment that is still serving:
 *
 *   DROP COLUMN / DROP TABLE -- the old client emits every column declared in
 *     ITS schema.prisma on any query without an explicit `select:`, so those
 *     queries fail with 42703 until promotion. This is the documented one.
 *   SET NOT NULL -- the old code still writes rows that omit the column (its
 *     client believes the column is nullable), and every such INSERT now fails
 *     with 23502. Worse than a read failure: the user's write is lost, not just
 *     a page.
 *   DROP INDEX / DROP CONSTRAINT -- a Prisma `upsert` compiles to INSERT ...
 *     ON CONFLICT against a named unique index. Drop that index and the old
 *     code's upserts fail outright ("no unique or exclusion constraint matching
 *     the ON CONFLICT specification"), which is a write path, silently, with no
 *     schema error to point at.
 *   RENAME -- the old client knows only the old name: reads and writes both
 *     fail. It is a DROP and an ADD wearing one statement.
 *   ALTER COLUMN ... TYPE -- narrowing a type (varchar(n), int -> smallint)
 *     rejects the old code's still-valid values.
 *
 * Not flagged, because they are safe while the old code runs: ADD COLUMN
 * (nullable, or NOT NULL with a DEFAULT), CREATE TABLE, CREATE INDEX, DROP
 * DEFAULT, and data-only UPDATE/INSERT.
 *
 * The guard is an acknowledgement gate, not a ban: some of these are genuinely
 * necessary, and the point is that the author states the plan in the migration
 * itself, where the next reader finds it, rather than discovering the window
 * during an incident.
 */

/** Marker a migration includes to declare its rolling-deploy plan reviewed. */
export const ROLLING_DEPLOY_ACK = "rolling-deploy:";

export type UnsafeShapeKind =
  | "drop-column"
  | "drop-table"
  | "set-not-null"
  | "drop-index"
  | "drop-constraint"
  | "rename"
  | "alter-type";

export type UnsafeShape = {
  kind: UnsafeShapeKind;
  /** The offending statement, whitespace-collapsed, for the failure message. */
  statement: string;
};

const PATTERNS: { kind: UnsafeShapeKind; re: RegExp }[] = [
  { kind: "drop-column", re: /\bDROP\s+COLUMN\b/i },
  { kind: "drop-table", re: /\bDROP\s+TABLE\b/i },
  { kind: "set-not-null", re: /\bSET\s+NOT\s+NULL\b/i },
  { kind: "drop-index", re: /\bDROP\s+INDEX\b/i },
  { kind: "drop-constraint", re: /\bDROP\s+CONSTRAINT\b/i },
  { kind: "rename", re: /\bRENAME\b/i },
  { kind: "alter-type", re: /\bALTER\s+COLUMN\b[\s\S]*\bTYPE\b/i },
];

/**
 * Strip SQL comments.
 *
 * Load-bearing rather than tidiness: Prisma's own generated migrations describe
 * the destructive change in a comment block ("Warning: You are about to drop the
 * column..."), so a detector that scanned raw text would flag every migration
 * that merely MENTIONS a drop, and a guard that cries wolf gets an ack line
 * pasted into everything.
 */
function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

/** Every single-release-unsafe statement in one migration's SQL. */
export function unsafeShapes(sql: string): UnsafeShape[] {
  const found: UnsafeShape[] = [];
  for (const raw of stripComments(sql).split(";")) {
    const statement = raw.replace(/\s+/g, " ").trim();
    if (statement.length === 0) continue;
    for (const { kind, re } of PATTERNS) {
      if (re.test(statement)) found.push({ kind, statement });
    }
  }
  return found;
}

/**
 * True when a migration declares its rolling-deploy plan.
 *
 * Read from the RAW file, before comments are stripped: the acknowledgement is
 * itself a comment. Requiring a non-empty reason after the marker is the whole
 * value -- a bare token would be a checkbox, and the reason is what a reader
 * during an incident actually needs.
 */
export function hasRollingDeployAck(sql: string): boolean {
  // [ \t] rather than \s after the colon: \s crosses the newline, so a bare
  // marker would pick up the next LINE as its reason and pass.
  const match = new RegExp(`--[ \\t]*${ROLLING_DEPLOY_ACK}[ \\t]*(.+)`, "i").exec(sql);
  return (match?.[1]?.trim().length ?? 0) > 0;
}

/**
 * Migrations at or before this timestamp are exempt.
 *
 * Not a way to duck the rule: every migration in the tree at the time this guard
 * landed had already been applied to production, and Prisma stores a CHECKSUM of
 * each migration.sql in _prisma_migrations. Editing an applied file to add an
 * acknowledgement line makes `migrate deploy` refuse to run at all
 * ("migration ... was modified after it was applied"), which would wedge every
 * future deploy -- exactly the outcome docs/DEPLOY.md's P3009 section is about.
 * So history is read-only and the rule starts here.
 */
export const GRANDFATHERED_THROUGH = "20260815000000";

/** True when a migration directory name predates the guard. */
export function isGrandfathered(migrationName: string): boolean {
  const timestamp = /^(\d{14})/.exec(migrationName)?.[1];
  // An unparseable name is NOT exempt: the safe default for something that does
  // not look like a migration is to check it.
  return timestamp !== undefined && timestamp <= GRANDFATHERED_THROUGH;
}
