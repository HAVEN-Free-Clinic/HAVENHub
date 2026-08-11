/**
 * Server-side barrel for the photos module.
 *
 * This re-exports service.ts (Prisma) and normalize.ts (sharp), so importing it
 * from a "use client" component would bundle both for the browser. Client
 * components import "@/platform/photos/shared" instead.
 */
export { PHOTO_CONTENT_TYPE, PHOTO_SIZE, PhotoError, photoUrl } from "./shared";
export { normalizePhoto } from "./normalize";
export { initialsSvg, toInitials } from "./initials";
export {
  ACCEPTED_UPLOAD_TYPES,
  removePhoto,
  resolvePhoto,
  setPhotoFromUpload,
  type ResolvedPhoto,
} from "./service";
