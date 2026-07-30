/**
 * My Info service: member-facing self-service mutations and queries.
 *
 * Every signed-in matched person (including alumni with no current term) can:
 *   - view their own contact details and active-term memberships
 *   - update four whitelisted contact fields (phone, contactEmail,
 *     yaleAffiliation, gradYear) -- never name, netId, or epicId
 *     (epicId is IT-managed; use the admin people service to update it)
 *   - declare they are not volunteering this term (sets VOLUNTEER memberships
 *     in the active term to REMOVED; DIRECTOR memberships are untouched --
 *     stepping down as a director goes through the EDs)
 *   - upload their HIPAA certificate PDF
 *
 * Permission checks are NOT this service's concern -- pages and server actions
 * gate via requireModuleAccess / requirePersonSession. This service:
 *   - whitelists fields at the service level (not just the form)
 *   - trusts the caller for permissions and personId authenticity
 *   - audits every mutation
 */

import { cache } from "react";
import type { HipaaCertificate } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { prisma } from "@/platform/db";
import { getActiveTerm } from "@/platform/terms/active-term";
import { isEffectiveActiveAdmin, assertActiveAdminRemainsTx } from "@/platform/rbac/last-admin";
import { recordAudit } from "@/platform/audit";
import { log, errorAttrs } from "@/platform/logging";
import { updatePersonFields } from "@/platform/people";
import { getSetting } from "@/platform/settings/service";
import { putObject } from "@/platform/storage";
import { extractCompletionDate } from "@/platform/compliance/parser";
import type { ParsedDate } from "@/platform/compliance/parser";
import { notifyDatelessCertReview, notifyCertNeedsVerification } from "@/platform/compliance/review-notifications";
import { recordSelfWithdrawal } from "@/platform/offboarding/self-withdrawal";

// ---------------------------------------------------------------------------
// Typed error
// ---------------------------------------------------------------------------

export class CertificateValidationError extends Error {
  constructor(public reason: string) {
    super(`Certificate validation failed: ${reason}`);
    this.name = "CertificateValidationError";
  }
}

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

/** The four fields a member is allowed to update for themselves via self-service.
 * epicId is intentionally excluded: it is IT-managed only. */
export type MyInfoInput = {
  phone?: string | null;
  contactEmail?: string | null;
  yaleAffiliation?: string | null;
  gradYear?: string | null;
  dietaryRestrictions?: string | null;
};

// ---------------------------------------------------------------------------
// Upload parsing
// ---------------------------------------------------------------------------

/**
 * Extract and validate the "certificate" File entry from a FormData object.
 *
 * Returns null when:
 *   - the "certificate" field is absent or not a File instance, or
 *   - the file is empty (size === 0).
 *
 * The caller (page action) is responsible for redirecting on null.
 * Validation of mime type, extension, and size is handled by saveCertificate.
 */
export function parseCertificateUpload(formData: FormData): {
  name: string;
  type: string;
  size: number;
  file: File;
} | null {
  const entry = formData.get("certificate");
  if (!(entry instanceof File)) return null;
  if (entry.size === 0) return null;
  return { name: entry.name, type: entry.type, size: entry.size, file: entry };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Return the person, the active term (or null), their ACTIVE memberships in
 * the current ACTIVE term (with term + department), and their latest HIPAA
 * certificate.
 *
 * The active term is returned directly so the page does not need a second
 * query for the AppShell term label.
 */
export async function getMyInfo(personId: string) {
  const [person, activeTerm] = await Promise.all([
    prisma.person.findUniqueOrThrow({ where: { id: personId } }),
    getActiveTerm(),
  ]);

  const memberships = activeTerm
    ? await prisma.termMembership.findMany({
        where: {
          personId,
          termId: activeTerm.id,
          status: "ACTIVE",
        },
        include: { term: true, department: true },
      })
    : [];

  return { person, activeTerm, memberships };
}

/**
 * The person's certificates, newest first. Memoized per request via cache():
 * a homepage render reads this from both the onboarding gate and the dashboard,
 * so without memoization the same query runs twice. Per-request only -- a fresh
 * upload is reflected on the next navigation.
 */
export const listMyCertificates = cache(
  async (personId: string): Promise<HipaaCertificate[]> => {
    return prisma.hipaaCertificate.findMany({
      where: { personId },
      orderBy: { uploadedAt: "desc" },
    });
  }
);

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Update the four whitelisted contact fields for the person identified by
 * personId. Extra keys in `input` (e.g. name, netId, epicId) are stripped here
 * at the service level before the platform call -- defense in depth beyond the
 * form. epicId is IT-managed and must never be updated via this path.
 *
 * Uses self as actor (actorPersonId === personId).
 */
export async function updateMyInfo(personId: string, input: MyInfoInput): Promise<void> {
  // Build a clean object containing ONLY the four allowed keys that are
  // present in the input. This is the service-level whitelist.
  // epicId is intentionally absent: it is IT-managed only.
  const allowedKeys: Array<keyof MyInfoInput> = [
    "phone",
    "contactEmail",
    "yaleAffiliation",
    "gradYear",
    "dietaryRestrictions",
  ];

  const clean: MyInfoInput = {};
  for (const key of allowedKeys) {
    if (key in (input as object)) {
      clean[key] = (input as Record<string, unknown>)[key] as string | null | undefined;
    }
  }

  await updatePersonFields(personId, personId, clean);
}

/**
 * Trim, blank-to-null, and cap a self-reported withdrawal reason.
 *
 * Normalized here rather than in the page action so it cannot be bypassed by a
 * direct service call, matching how updateMyInfo whitelists fields at the service
 * level rather than trusting the form.
 */
const MAX_REASON_LENGTH = 300;

function normalizeReason(reason: string | null | undefined): string | null {
  if (!reason || typeof reason !== "string") return null;
  const trimmed = reason.trim();
  if (trimmed === "") return null;
  return trimmed.slice(0, MAX_REASON_LENGTH);
}

/**
 * Set the person's own ACTIVE VOLUNTEER memberships in the active term to
 * REMOVED. Returns the count of memberships withdrawn. When there are none,
 * returns 0 and does NOT write an audit row.
 *
 * DIRECTOR memberships are deliberately untouched: stepping down as a director
 * is a decision that goes through the executive directors.
 *
 * Removing the memberships is only half an offboard (Person.status stays ACTIVE,
 * so Epic access and compliance reminders continue), and it makes the person
 * disappear from the department cards on /volunteers/offboarding. So after the
 * removal commits, recordSelfWithdrawal puts them in the offboarding queue and
 * alerts the people who can process it. That call is best-effort: the withdrawal
 * is already committed and audited, so a notification failure must not surface to
 * the member as a failed action (same treatment as saveCertificate's alerts).
 */
export async function withdrawFromTerm(personId: string, reason?: string | null): Promise<number> {
  const activeTerm = await getActiveTerm();

  if (!activeTerm) return 0;

  const where = {
    personId,
    termId: activeTerm.id,
    kind: "VOLUNTEER" as const,
    status: "ACTIVE" as const,
  };

  // Read the departments BEFORE the update: the offboarding alert names them, and
  // once the rows are REMOVED there is no way to tell which ones they were.
  const leaving = await prisma.termMembership.findMany({
    where,
    select: { department: { select: { code: true } } },
  });
  const departmentCodes = [...new Set(leaving.map((m) => m.department.code))].sort();

  const cleanReason = normalizeReason(reason);

  // Last-admin guard (#97): dept/kind-scoped admin grants resolve through ACTIVE
  // memberships, so a self-leave can strip the last admin path exactly like an
  // admin-initiated removeMembership -- which guards this and self-leave did not,
  // letting the last admin lock everyone out of the admin module with one click.
  // Fast-path non-admins; for an effective admin, remove and recompute inside one
  // Serializable tx so the withdrawal rolls back (LastAdminError) if it would leave
  // zero effective admins (mirrors roster.ts removeMembership).
  let count: number;
  if (await isEffectiveActiveAdmin(personId)) {
    count = await prisma.$transaction(
      async (tx) => {
        const removed = await tx.termMembership.updateMany({ where, data: { status: "REMOVED" } });
        await assertActiveAdminRemainsTx(tx);
        return removed.count;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } else {
    const removed = await prisma.termMembership.updateMany({ where, data: { status: "REMOVED" } });
    count = removed.count;
  }

  if (count === 0) return 0;

  await recordAudit({
    actorPersonId: personId,
    action: "my-info.withdraw",
    entityType: "Person",
    entityId: personId,
    after: { termId: activeTerm.id, count, reason: cleanReason },
  });

  try {
    const me = await prisma.person.findUnique({
      where: { id: personId },
      select: { name: true },
    });
    await recordSelfWithdrawal(
      prisma,
      { id: personId, name: me?.name ?? "A volunteer" },
      { departmentCodes, reason: cleanReason },
    );
  } catch (err) {
    log.error(
      "[my-info] failed to flag and alert on self-withdrawal",
      errorAttrs(err, { personId, termId: activeTerm.id }),
    );
  }

  return count;
}

/** Type for the optional parse function injected into saveCertificate (for testing). */
type ParseFn = (bytes: Buffer) => Promise<ParsedDate | null>;

/**
 * Validate, store, and record a HIPAA certificate upload.
 *
 * Order of operations (write-after-commit strategy):
 *   1. Validate (mime, extension, size)
 *   2. For PDF files: attempt to parse the completion date from the bytes
 *      (try/catch -- parser errors do NOT fail the upload; result -> NONE)
 *   3. prisma.$transaction: create HipaaCertificate row
 *   4. AFTER commit: write bytes to UPLOAD_DIR/<cert.id>.pdf
 *   5. If disk write fails: delete the cert row and rethrow
 *   6. Audit my-info.certificate_upload (fileName + size only; never bytes)
 *   7. If no completion date was parsed, alert compliance managers so the
 *      manual-verification queue is driven -- the member cannot set the date
 *      themselves. Deduped: a re-upload into an already-pending state is silent.
 *
 * @param parse - Optional injected parser function (defaults to extractCompletionDate).
 *   Passed by tests to avoid real PDF I/O. Public call sites leave this undefined.
 */
export async function saveCertificate(
  personId: string,
  file: { name: string; type: string; size: number; bytes: Buffer },
  parse: ParseFn = extractCompletionDate
): Promise<HipaaCertificate> {
  // --- 1. Validate ---
  if (file.type !== "application/pdf") {
    throw new CertificateValidationError(
      `Invalid mime type "${file.type}"; only application/pdf is accepted`
    );
  }
  if (!file.name.toLowerCase().endsWith(".pdf")) {
    throw new CertificateValidationError(
      `File extension must be .pdf; got "${file.name}"`
    );
  }
  const maxMb = await getSetting<number>("uploads.maxMb");
  const maxBytes = maxMb * 1024 * 1024;
  if (file.size > maxBytes) {
    throw new CertificateValidationError(
      `File too large: ${file.size} bytes exceeds the ${maxMb} MB limit`
    );
  }

  // --- 2. Parse completion date from PDF bytes (errors do not fail the upload) ---
  let parsedDate: ParsedDate | null = null;
  if (file.type === "application/pdf") {
    try {
      parsedDate = await parse(file.bytes);
    } catch {
      // Parser failure is non-fatal; completionDate stays null, extraction stays NONE
    }
  }

  // Dedup signals for the review notifications (step 7): snapshot the member's
  // CURRENT newest cert BEFORE inserting the new row so a re-upload into the same
  // state does not re-alert compliance managers.
  const priorNewest = await prisma.hipaaCertificate.findFirst({
    where: { personId },
    orderBy: { uploadedAt: "desc" },
    select: { completionDate: true, verifiedAt: true },
  });
  // Dateless: newest existing cert already had no date (parse also failed now).
  const alreadyPending = parsedDate === null && priorNewest?.completionDate === null;
  // Awaiting verification: newest existing cert already had a date but was unverified.
  const alreadyPendingVerification =
    priorNewest != null && priorNewest.completionDate !== null && priorNewest.verifiedAt === null;

  // --- 3. Transaction: create the certificate row ---
  const cert = await prisma.$transaction(async (tx) => {
    // The storedName is derived from the cert id; we need the id first.
    // Generate a placeholder and then derive; Prisma uses cuid by default.
    // Instead, create the row and use cert.id.
    const created = await tx.hipaaCertificate.create({
      data: {
        personId,
        fileName: file.name,
        // Create the row first to obtain its id, then update storedName to "<id>.pdf" in the same transaction.
        storedName: "pending",
        size: file.size,
        mimeType: file.type,
        ...(parsedDate
          ? { completionDate: parsedDate.date, extraction: "PARSED" }
          : { extraction: "NONE" }),
      },
    });

    const storedName = `${created.id}.pdf`;

    const updated = await tx.hipaaCertificate.update({
      where: { id: created.id },
      data: { storedName },
    });

    return updated;
  });

  // --- 4. Write bytes to storage (after tx commits) ---
  try {
    await putObject(cert.storedName, file.bytes, file.type);
  } catch (err) {
    // --- 5. Storage write failed: clean up the DB row so it is not orphaned ---
    try {
      await prisma.hipaaCertificate.delete({ where: { id: cert.id } });
    } catch (cleanupErr) {
      log.error("[my-info] failed to clean up cert row after disk error", errorAttrs(cleanupErr, { certId: cert.id }));
    }
    throw err;
  }

  // --- 6. Audit (fileName + size; never bytes) ---
  await recordAudit({
    actorPersonId: personId,
    action: "my-info.certificate_upload",
    entityType: "HipaaCertificate",
    entityId: cert.id,
    after: { fileName: cert.fileName, size: cert.size },
  });

  // --- 7. Alert compliance managers that the new cert needs their attention ---
  // The cert is already durably saved and audited; a notification hiccup must not
  // surface to the member as a failed upload, so failures are logged only. A fresh
  // upload is always unverified (verifiedAt defaults to null), so there are two
  // manager-facing cases, deduped against the pre-insert snapshot:
  //   - no readable date  -> a manager must set the date (member cannot self-fix)
  //   - date but unverified -> a manager must verify it (blocks the member until then)
  if (parsedDate === null && !alreadyPending) {
    try {
      const owner = await prisma.person.findUnique({
        where: { id: personId },
        select: { name: true },
      });
      await notifyDatelessCertReview(prisma, { id: personId, name: owner?.name ?? "A volunteer" });
    } catch (err) {
      log.error("[my-info] failed to notify compliance managers of dateless cert", errorAttrs(err, { certId: cert.id }));
    }
  } else if (parsedDate !== null && !alreadyPendingVerification) {
    try {
      const owner = await prisma.person.findUnique({
        where: { id: personId },
        select: { name: true },
      });
      await notifyCertNeedsVerification(prisma, { id: personId, name: owner?.name ?? "A volunteer" });
    } catch (err) {
      log.error("[my-info] failed to notify compliance managers of cert awaiting verification", errorAttrs(err, { certId: cert.id }));
    }
  }

  return cert;
}

