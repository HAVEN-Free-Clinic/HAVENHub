import { randomUUID } from "crypto";
import { unzipSync } from "fflate";
import { Prisma } from "@prisma/client";
import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { recordAudit } from "@/platform/audit";
import { putObject, deletePrefix } from "@/platform/storage";
import { parseManifest, ManifestError } from "../engine/manifest";
import { LearningAuthError, LearningValidationError } from "./errors";

const MAX_FILES = 2000;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024; // 100 MB unzipped

/**
 * How many package files are written to storage at once (audit 14,
 * scorm-ingest-serial-uploads).
 *
 * The upload loop used to be strictly serial, so a package's wall clock was
 * MAX_FILES round trips deep: a real eXeLearning export runs a few hundred small
 * files, and at R2's ~40-80ms per PUT from iad1 that is 20-40s of pure latency
 * for a 5 MB package -- inside a Server Action that, until this same audit,
 * declared no maxDuration at all (the manage page now sets 300). A timeout here
 * is not merely slow: files are written before the DB manifest update, so the
 * course keeps serving the OLD package while a half-written new prefix is
 * orphaned in storage, and the admin sees a generic action failure.
 *
 * Bounded rather than Promise.all over every entry: 2000 concurrent PUTs would
 * hold 2000 buffers plus 2000 sockets and trip R2 rate limits, which is how a
 * fix for a slow upload becomes a failed one. Eight is the usual sweet spot for
 * small-object S3-compatible writes -- enough to hide per-request latency, few
 * enough to stay well inside the function's memory and socket budget.
 */
const UPLOAD_CONCURRENCY = 8;

/**
 * Run `task` over `items` with at most `limit` in flight.
 *
 * Workers pull from a shared cursor rather than being handed a fixed slice, so
 * one slow file cannot leave the other workers idle. The first rejection
 * propagates through Promise.all; the remaining workers stop at their next
 * cursor read, and their promises are still awaited by that Promise.all, so a
 * second failure can never surface as an unhandled rejection.
 */
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<void>
): Promise<void> {
  let cursor = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        await task(items[index]);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  ico: "image/x-icon",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  pdf: "application/pdf",
};

export function contentTypeFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/** Reject path-traversal and absolute paths in zip entry names. */
function safeRelPath(name: string): string {
  const norm = name.replace(/\\/g, "/").replace(/^\/+/, "");
  if (norm.split("/").some((seg) => seg === "..")) {
    throw new LearningValidationError(`Unsafe path in package: ${name}`);
  }
  return norm;
}

async function requireManager(actorId: string): Promise<void> {
  if (!(await can(actorId, "learning.manage_courses"))) {
    throw new LearningAuthError("You do not have permission to manage courses.");
  }
}

/**
 * Unzip a SCORM 1.2 package, validate its manifest, store every file under
 * scorm/<courseId>/, and record the launch href + version on the course.
 * Replacing: the existing scorm/<courseId>/ tree is deleted first.
 *
 * When `resetProgress` is set (the admin's choice on a replace), every learner's
 * CourseProgress and ScoProgress for this course is deleted in the same
 * transaction as the manifest update. This is the only way to keep completion
 * honest across a content swap: the new package's SCO ids generally differ from
 * the old one's, so prior per-SCO rows would otherwise be orphaned and the
 * course-level COMPLETE rollup would persist for content the learner never took
 * (falsely clearing the onboarding/training gate). Left false, prior progress is
 * preserved unchanged.
 *
 * Deliberately NOT scoped to the active term the way dashboard.ts's per-learner
 * resetCourseProgress is. That reset is about giving one person a fresh attempt at
 * content that has not changed, so a prior term's row is still a genuine
 * compliance record and is left alone. This one is about the content itself
 * changing: every existing ScoProgress row references SCO ids from the OLD
 * manifest, which the new manifest may not even have, so no term's row is a valid
 * completion of what is now being served -- there is no "current term only" that
 * would leave a meaningful record behind, only orphaned rows pointing at deleted
 * content. Scoping this delete would just relocate the orphans instead of
 * clearing them.
 */
export async function ingestScormPackage(
  courseId: string,
  zipBytes: Buffer,
  actorId: string,
  opts: { resetProgress?: boolean } = {}
): Promise<void> {
  await requireManager(actorId);
  const course = await prisma.course.findUnique({ where: { id: courseId } });
  if (!course) throw new LearningValidationError("Course not found.");

  // Bound decompression AS entries are read, not after: a decompression bomb
  // inflates to gigabytes, so reject on each entry's declared uncompressed size
  // (from the zip directory) BEFORE fflate materializes it, keeping peak memory at
  // ~MAX_TOTAL_BYTES instead of loading the whole inflated archive first. The
  // post-unzip byteLength checks below stay as defense in depth (a directory that
  // understates a size is still caught, just after that one entry inflates).
  let entries: Record<string, Uint8Array>;
  let declaredBytes = 0;
  let acceptedFiles = 0;
  let tooManyFiles = false;
  let tooLarge = false;
  try {
    entries = unzipSync(new Uint8Array(zipBytes), {
      filter: (file) => {
        if (file.name.endsWith("/")) return false; // directory entry: never inflate
        if (acceptedFiles + 1 > MAX_FILES) {
          tooManyFiles = true;
          return false;
        }
        if (file.originalSize > MAX_TOTAL_BYTES || declaredBytes + file.originalSize > MAX_TOTAL_BYTES) {
          tooLarge = true;
          return false;
        }
        declaredBytes += file.originalSize;
        acceptedFiles += 1;
        return true;
      },
    });
  } catch {
    throw new LearningValidationError("Could not read the uploaded file as a .zip.");
  }
  if (tooManyFiles) throw new LearningValidationError("The package has too many files.");
  if (tooLarge) throw new LearningValidationError("The package is too large.");

  // Drop directory entries (zero-length, trailing slash).
  const files = Object.entries(entries).filter(([name]) => !name.endsWith("/"));
  if (files.length === 0) throw new LearningValidationError("The package is empty.");
  if (files.length > MAX_FILES) throw new LearningValidationError("The package has too many files.");
  const totalBytes = files.reduce((sum, [, bytes]) => sum + bytes.byteLength, 0);
  if (totalBytes > MAX_TOTAL_BYTES) throw new LearningValidationError("The package is too large.");

  // Find the manifest (SCORM requires it at the package root).
  const manifestEntry = files.find(([name]) => name.toLowerCase() === "imsmanifest.xml");
  if (!manifestEntry) throw new LearningValidationError("The package has no imsmanifest.xml at its root.");

  let parsed;
  try {
    parsed = parseManifest(Buffer.from(manifestEntry[1]).toString("utf8"));
  } catch (err) {
    if (err instanceof ManifestError) throw new LearningValidationError(err.message);
    throw err;
  }

  // Stage the new package under a fresh, versioned prefix and make the DB manifest
  // update the single source of truth. The previous package stays intact until the
  // DB write commits, so a failed write never leaves the course pointing at deleted
  // files (audit F17). scormEntryHref/scormScos stay relative (no key baked in).
  const oldKey = course.scormBlobKey;
  const blobKey = randomUUID();

  // Validate every entry name BEFORE the first write. safeRelPath throws, and
  // when it threw mid-loop the entries ahead of the bad one were already in
  // storage under the new prefix that nothing would ever clean up (the DB write
  // that records blobKey never happens). Cheap string work, so do it all first.
  const staged = files.map(([name, bytes]) => ({ rel: safeRelPath(name), bytes }));

  await mapWithConcurrency(staged, UPLOAD_CONCURRENCY, async ({ rel, bytes }) => {
    await putObject(`scorm/${courseId}/${blobKey}/${rel}`, Buffer.from(bytes), contentTypeFor(rel));
  });

  const updateCourse = prisma.course.update({
    where: { id: courseId },
    data: {
      scormEntryHref: parsed.entryHref,
      scormVersion: parsed.version,
      scormScos: parsed.scos as unknown as Prisma.InputJsonValue,
      scormUploadedAt: new Date(),
      scormBlobKey: blobKey,
    },
  });

  // Commit the manifest (and optional progress reset) BEFORE deleting the old
  // package, so a DB failure leaves the previous package fully intact and served.
  // Wipe progress in the same transaction as the manifest update so we never end
  // up with new content but stale completion (or vice versa) if a write fails.
  let resetLearners = 0;
  if (opts.resetProgress) {
    const [cleared] = await prisma.$transaction([
      prisma.courseProgress.deleteMany({ where: { courseId } }),
      prisma.scoProgress.deleteMany({ where: { courseId } }),
      updateCourse,
    ]);
    resetLearners = cleared.count;
  } else {
    await updateCourse;
  }

  // Manifest now points at the new prefix; clean up the old package. A failure here
  // only orphans blobs (harmless), not a broken course. When oldKey is null the
  // previous package (if any) lived at the flat prefix scorm/<courseId>/, which we
  // deliberately do NOT prefix-delete here because it also matches the new
  // versioned files; those legacy flat files become harmless orphans.
  if (oldKey) {
    await deletePrefix(`scorm/${courseId}/${oldKey}/`);
  }

  await recordAudit({
    actorPersonId: actorId,
    action: "learning.package_upload",
    entityType: "Course",
    entityId: courseId,
    after: {
      entryHref: parsed.entryHref,
      version: parsed.version,
      fileCount: files.length,
      scoCount: parsed.scos.length,
      resetProgress: !!opts.resetProgress,
      resetLearners,
    },
  });
}
