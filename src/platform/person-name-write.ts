/**
 * Keeping `Person.name` honest on every write.
 *
 * `name` is a DERIVED column: it must always equal `displayNameOf` of the parts
 * beside it. Enforcing that by convention across every write path is exactly the
 * kind of rule that holds until somebody adds the eleventh one, so it is
 * enforced here instead, from a Prisma client extension applied in
 * platform/db.ts. Every `person.create` / `update` / `upsert` / `createMany` /
 * `updateMany` passes through `reconcilePersonNameWrite` first, whether it came
 * from a service, a script, a seed, or a test.
 *
 * The reconciliation is deliberately pure and read-free. An extension that
 * loaded the current row to fill in the blanks would issue that read on the
 * outer client, which inside `prisma.$transaction` reads pre-transaction state
 * and can deadlock against the very row being written. So a write must carry
 * enough information to be reconciled on its own: either a `name`, or both
 * `legalFirstName` and `lastName`. A partial parts update throws, and the fix is
 * to route it through platform/people.ts, which loads the person and sends
 * complete parts.
 */
import { Prisma } from "@prisma/client";
import {
  displayNameOf,
  splitPersonName,
  type SplitName,
} from "./person-name";

/** The six columns this module owns. Everything else passes through. */
const NAME_FIELDS = [
  "name",
  "legalFirstName",
  "legalMiddleName",
  "lastName",
  "preferredFirstName",
  "nameNeedsReview",
] as const;

type WriteData = Record<string, unknown>;

/**
 * Prisma accepts `{ set: value }` wherever it accepts a scalar. Reading through
 * that would mean re-implementing the field-operation grammar, so we refuse it
 * on the name columns instead: no caller in this codebase writes a name that
 * way, and a silent misread would put a `[object Object]` on a roster.
 */
function scalar(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  throw new Error(
    `Person.${field} must be written as a plain string, not a Prisma field operation. ` +
      `Received ${JSON.stringify(value)}.`,
  );
}

function touchesName(data: WriteData): boolean {
  // nameNeedsReview is excluded on purpose. Clearing the flag is a human saying
  // "these parts are right", which changes no name VALUE, so it needs no parts
  // alongside it and must not be forced down the reconcile path.
  return NAME_FIELDS.some((field) => field !== "nameNeedsReview" && field in data);
}

/**
 * Reconcile the name columns of one Person write.
 *
 * Returns `data` unchanged (by reference, so the caller can tell) when the write
 * touches no name column. Otherwise returns a copy whose `name` is derived from
 * its parts and whose parts are consistent with it.
 *
 * Precedence when both arrive: the PARTS win. A caller sending both is normally
 * platform/people.ts echoing back the name it just derived, and trusting the
 * parts means a stale `name` can never overwrite a good split.
 */
export function reconcilePersonNameWrite(
  operation: "create" | "update",
  data: WriteData,
): WriteData {
  // An update that names nothing is none of this module's business. A create
  // always is: the columns carry a `DEFAULT ''` so the migration could add them
  // NOT NULL, and letting that default reach a row would seat a nameless person
  // on the roster.
  if (operation === "update" && !touchesName(data)) return data;

  const legalFirstName = scalar(data.legalFirstName, "legalFirstName");
  const lastName = scalar(data.lastName, "lastName");
  const hasParts = legalFirstName !== null && lastName !== null;

  if (hasParts) {
    // A blank surname is a mononym and perfectly real. A blank given name is
    // nobody, and it arrives here rather than at the "no name at all" branch
    // below because an empty form box posts "" rather than nothing.
    if (legalFirstName.trim() === "") {
      throw new Error(
        "A Person write must carry a non-empty legalFirstName. A blank lastName is " +
          "fine (a mononym); a blank given name is not a person.",
      );
    }
    const parts = {
      legalFirstName,
      legalMiddleName: scalar(data.legalMiddleName, "legalMiddleName"),
      lastName,
      preferredFirstName: scalar(data.preferredFirstName, "preferredFirstName"),
    };
    return {
      ...data,
      ...parts,
      name: displayNameOf(parts),
      nameNeedsReview: data.nameNeedsReview === true,
    };
  }

  // No usable parts, so the write must carry a name we can split.
  const name = scalar(data.name, "name");
  if (name === null || name.trim() === "") {
    if ("legalFirstName" in data || "lastName" in data || "preferredFirstName" in data) {
      throw new Error(
        "A Person write that sets any name part must set both legalFirstName and lastName, " +
          "so the derived `name` can be recomputed. Route partial edits through " +
          "platform/people.ts, which loads the person and sends complete parts.",
      );
    }
    throw new Error(
      `A Person ${operation} must supply either \`name\` or both \`legalFirstName\` and \`lastName\`.`,
    );
  }

  const split: SplitName = splitPersonName(name);
  return {
    ...data,
    legalFirstName: split.legalFirstName,
    legalMiddleName: split.legalMiddleName,
    lastName: split.lastName,
    preferredFirstName: split.preferredFirstName,
    name: displayNameOf(split),
    nameNeedsReview: data.nameNeedsReview === true || split.needsReview,
  };
}

/**
 * Reconcile one write payload in place, preserving the caller's static type.
 * The cast is contained here: `reconcilePersonNameWrite` works on a plain record
 * because Prisma's create and update input types differ per operation, and this
 * only ever adds or overwrites the six name columns those types already carry.
 */
function apply<T>(operation: "create" | "update", data: T): T {
  return reconcilePersonNameWrite(operation, data as WriteData) as T;
}

function applyEach<T>(operation: "create" | "update", data: T | T[]): T | T[] {
  return Array.isArray(data)
    ? data.map((row) => apply(operation, row))
    : apply(operation, data);
}

/**
 * A FUNCTION, not a module-scope constant, and that is load-bearing.
 *
 * `Prisma.defineExtension` throws the moment it is CALLED in a browser
 * ("unable to run in this browser environment"). `platform/db.ts` is reachable
 * from the client bundle today: a builder client component imports one constant
 * from platform/recruitment/incoming-roster.ts, which imports `prisma`. That
 * leak was survivable while db.ts only ever constructed a PrismaClient, whose
 * browser build defers its error until a query runs. Calling defineExtension at
 * module scope turned it fatal, and took the whole form builder down with it:
 * server-rendered 200, then a client error boundary, which only e2e sees.
 *
 * Deferring the call to `makePrismaClient()` keeps module evaluation harmless in
 * any bundle, so the extension can never be the thing that breaks a page.
 */
export function personNameWriteExtension() {
  return Prisma.defineExtension({
  name: "person-name-write",
  query: {
    person: {
      create({ args, query }) {
        args.data = apply("create", args.data);
        return query(args);
      },
      update({ args, query }) {
        args.data = apply("update", args.data);
        return query(args);
      },
      upsert({ args, query }) {
        args.create = apply("create", args.create);
        args.update = apply("update", args.update);
        return query(args);
      },
      createMany({ args, query }) {
        args.data = applyEach("create", args.data);
        return query(args);
      },
      createManyAndReturn({ args, query }) {
        args.data = applyEach("create", args.data);
        return query(args);
      },
      updateMany({ args, query }) {
        args.data = applyEach("update", args.data);
        return query(args);
      },
    },
  },
  });
}
