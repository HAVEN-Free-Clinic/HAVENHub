import type { Prisma } from "@prisma/client";

/**
 * The Person projection for the app's hottest read paths, and the mechanism that
 * lets it survive a migration that narrows Person.
 *
 * WHY A PROJECTION AT ALL. Prisma builds a query's column list from
 * `schema.prisma`, not from what the calling code touches, so a query with no
 * projection (and an `include:`, which only names relations) emits every declared
 * column. `prisma migrate deploy` runs at the START of the Vercel build while the
 * PREVIOUS deployment still serves traffic, so the moment a column is dropped
 * those queries ask the database for a column it no longer has and every one of
 * them returns 42703 until the new deployment is promoted.
 *
 * On Person that is not a module outage, it is the whole authenticated app:
 * getActivePerson (src/platform/auth/match-person.ts) runs on every request for
 * session validation. It happened. Migration 20260812232000_person_languages
 * dropped `Person.spanishSelfReported`, and production filed
 * `PrismaClientKnownRequestError: The column Person.spanishSelfReported does not
 * exist in the current database` from `prisma.person.findUnique()` (issues #597
 * and #598, 2026-08-13).
 *
 * WHAT AUDIT 14 FOUND (person-scalars-projection-does-not-close-deploy-window).
 * The first version of this file listed every Person scalar and stopped there,
 * and its test asserted exactly that: "names every Person scalar, and nothing
 * else". A projection that names every column emits the same SQL as no
 * projection, INCLUDING the column that is about to be dropped, so it changed
 * nothing about the failing query -- while docs/DEPLOY.md recorded the read path
 * as fixed. Naming the columns is not what saves the old deployment. NOT naming
 * the doomed one is.
 *
 * The catch is that the doomed column is still in `schema.prisma` in release N,
 * because the DROP migration cannot be written until release N+1. So the
 * projection has to be told, one release ahead, which columns are on their way
 * out. That is PERSON_DROP_PENDING.
 *
 * THE TWO-RELEASE PROCEDURE, which is now enforced rather than described:
 *
 *   Release N   Add the column's name to PERSON_DROP_PENDING. It leaves
 *               PERSON_SCALARS immediately, so the projected result type loses
 *               the field and `tsc` fails at every site that still reads it --
 *               starting with getActivePerson's `Promise<Person | null>`
 *               annotation, which must narrow to the projected type. Delete
 *               those reads. Ship. The serving release's SQL no longer names the
 *               column.
 *   Release N+1 Remove the field from schema.prisma, from ALL_PERSON_SCALARS and
 *               from PERSON_DROP_PENDING, and write the DROP migration. During
 *               the build window release N is serving and never asks for it.
 *
 * WHAT THIS STILL DOES NOT COVER, so nobody credits it with more than it does:
 * only queries that pass PERSON_SCALARS are protected. `matchPersonByClaim` in
 * match-person.ts -- the three lookups the Entra sign-in path runs -- passes no
 * projection at all, so a narrowing migration still refuses every NEW sign-in for
 * the length of the build even once the session path survives. Same for any
 * ad-hoc `prisma.person.find*` elsewhere. Audit 14 filed that as DM-1.
 *
 * Two things keep the list honest, and both matter:
 *   - `satisfies Prisma.PersonSelect` rejects a key that is not a Person field,
 *     so REMOVING a column fails `tsc` here, at a line whose comment explains
 *     the deploy window, rather than in production during a build.
 *   - getActivePerson's return type is derived from this object, so a scalar
 *     missing from ALL_PERSON_SCALARS leaves callers short of the field.
 * person-scalars.test.ts asserts the same thing against Prisma's DMMF, so the
 * failure names the specific field instead of a structural mismatch.
 *
 * Deliberately a leaf module importing only a Prisma type, so anything that
 * queries Person can use it without pulling in a service graph.
 */

/**
 * Every Person scalar in the schema. Not exported: callers want PERSON_SCALARS,
 * which is this minus anything queued for removal.
 */
const ALL_PERSON_SCALARS = {
  id: true,
  netId: true,
  entraObjectId: true,
  name: true,
  contactEmail: true,
  phone: true,
  epicId: true,
  yaleAffiliation: true,
  pronouns: true,
  staffTitle: true,
  dateOfBirth: true,
  dietaryRestrictions: true,
  themePreference: true,
  gradYear: true,
  photoKey: true,
  photoSource: true,
  photoVersion: true,
  photoUpdatedAt: true,
  photoSuppressed: true,
  photoSyncedAt: true,
  photoSyncMisses: true,
  status: true,
  airtableRecordId: true,
  addedToEhs: true,
  licensedRN: true,
  doNotRehire: true,
  doNotRehireNote: true,
  doNotRehireSetById: true,
  doNotRehireSetAt: true,
  blockerGateExempt: true,
  lastLoginAt: true,
  lastLoginUserAgent: true,
  lastLoginCity: true,
  lastLoginCountry: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.PersonSelect;

/**
 * Columns whose DROP migration ships in the NEXT release.
 *
 * Empty is the normal state. Adding a name here is release N of the procedure
 * above; it must be emptied again in release N+1, in the same commit as the DROP.
 * Nothing else in the app should read this: it exists to shape the projection and
 * to make `tsc` find the readers.
 */
export const PERSON_DROP_PENDING = [] as const satisfies readonly (keyof typeof ALL_PERSON_SCALARS)[];

/**
 * Drop the pending keys from a projection.
 *
 * Exported for the test: with PERSON_DROP_PENDING empty (the healthy state) the
 * mechanism is invisible at runtime, and an untested mechanism that only runs on
 * the day of a risky migration is not a mechanism. The cast is sound because the
 * runtime filter removes exactly the keys the `Omit` removes.
 */
export function omitPendingDrops<T extends object, K extends string>(
  all: T,
  pending: readonly K[]
): Omit<T, K> {
  const keep = Object.entries(all).filter(([key]) => !(pending as readonly string[]).includes(key));
  return Object.fromEntries(keep) as Omit<T, K>;
}

/**
 * Every Person scalar the serving release is allowed to ask the database for.
 *
 * Passing this to a `select:` keeps the result assignable wherever the full
 * `Person` was expected, EXCEPT for fields queued in PERSON_DROP_PENDING -- and
 * that exception is the point, because it is what makes `tsc` name the code that
 * has to change before the DROP can ship.
 */
export const PERSON_SCALARS = omitPendingDrops(
  ALL_PERSON_SCALARS,
  PERSON_DROP_PENDING
) satisfies Prisma.PersonSelect;

/** The schema's full scalar list, for the DMMF guard in person-scalars.test.ts. */
export const ALL_PERSON_SCALARS_FOR_TEST = ALL_PERSON_SCALARS;
