import type { Prisma } from "@prisma/client";

/**
 * Every Person scalar, named explicitly, for queries that need the whole row.
 *
 * Why this exists rather than letting Prisma imply the column list: Prisma builds
 * that list from `schema.prisma`, not from what the calling code touches, so a
 * query with no projection (and an `include:`, which only names relations) emits
 * every declared column. `prisma migrate deploy` runs at the START of the Vercel
 * build while the PREVIOUS deployment still serves traffic, so the moment a
 * column is dropped those queries ask the database for a column it no longer has
 * and every one of them returns 42703 until the new deployment is promoted.
 *
 * On Person that is not a module outage, it is the whole authenticated app:
 * getActivePerson (src/platform/auth/match-person.ts) runs on every request for
 * session validation. It happened. Migration 20260812232000_person_languages
 * dropped `Person.spanishSelfReported`, and production filed
 * `PrismaClientKnownRequestError: The column Person.spanishSelfReported does not
 * exist in the current database` from `prisma.person.findUnique()` (issues #597
 * and #598, 2026-08-13). Measured in audit 13: a no-projection query and an
 * `include:`-only query both fail that way; an explicit `select:` survives.
 *
 * Listing every scalar keeps the result assignable to `Person`, so this is a
 * pure hardening with no type churn at the call sites.
 *
 * Two things keep this list honest, and both matter:
 *   - `satisfies Prisma.PersonSelect` rejects a key that is not a Person field,
 *     so REMOVING a column fails `tsc` here, at a line whose comment explains
 *     the deploy window, rather than in production during a build.
 *   - getActivePerson is annotated `Promise<Person | null>`, so the selected
 *     object has to be assignable to `Person`. That makes ADDING a column fail
 *     too: a scalar missing from this list leaves the result short of `Person`.
 * Between them the list cannot drift in either direction without `tsc` saying
 * so. person-scalars.test.ts asserts the same thing against Prisma's DMMF, so
 * the failure names the specific field instead of a structural mismatch.
 *
 * Deliberately a leaf module importing only a Prisma type, so anything that
 * queries Person can use it without pulling in a service graph.
 */
export const PERSON_SCALARS = {
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
