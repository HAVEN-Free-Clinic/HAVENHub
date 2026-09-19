/** Upload limits for VIDEO courses, shared by the course editor (a friendly
 *  check before uploading) and the upload-URL route (the enforced one). */

/** R2 takes a single PUT up to 5 GiB; a Zoom recording of a morning session is
 *  1-2 GB, so this leaves room without inviting something absurd. */
export const MAX_VIDEO_BYTES = 5 * 1024 * 1024 * 1024;

/** A Zoom transcript .vtt for a few hours is well under a megabyte. */
export const MAX_CAPTIONS_BYTES = 5 * 1024 * 1024;

export const VIDEO_CONTENT_TYPES = ["video/mp4", "video/webm", "video/quicktime"] as const;
