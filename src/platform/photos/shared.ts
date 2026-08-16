/**
 * Photo values shared by server and client code.
 *
 * This module imports NOTHING on purpose. normalize.ts pulls in sharp and
 * service.ts pulls in Prisma, so any client component reaching those (or the
 * index.ts barrel that re-exports them) would bundle a native image library and
 * a database client into the browser. Client components import this file
 * directly instead.
 */

/** Stored photos are square at this edge length, in pixels. */
export const PHOTO_SIZE = 512;

/** Every stored photo is WebP, regardless of what came in. */
export const PHOTO_CONTENT_TYPE = "image/webp";

/** Thrown when bytes cannot be decoded, or an upload fails validation. */
export class PhotoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhotoError";
  }
}

/**
 * The versioned URL an in-app <img> points at.
 *
 * The ?v= parameter is what makes the route's long immutable cache safe: it
 * changes on every photo set and every removal.
 */
export function photoUrl(person: { id: string; photoVersion: number }): string {
  return `/api/people/${person.id}/photo?v=${person.photoVersion}`;
}
