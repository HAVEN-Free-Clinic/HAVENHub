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

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(zipBytes));
  } catch {
    throw new LearningValidationError("Could not read the uploaded file as a .zip.");
  }

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

  // Replace: clear any previous package for this course first.
  await deletePrefix(`scorm/${courseId}/`);

  for (const [name, bytes] of files) {
    const rel = safeRelPath(name);
    await putObject(`scorm/${courseId}/${rel}`, Buffer.from(bytes), contentTypeFor(rel));
  }

  const updateCourse = prisma.course.update({
    where: { id: courseId },
    data: {
      scormEntryHref: parsed.entryHref,
      scormVersion: parsed.version,
      scormScos: parsed.scos as unknown as Prisma.InputJsonValue,
      scormUploadedAt: new Date(),
    },
  });

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
