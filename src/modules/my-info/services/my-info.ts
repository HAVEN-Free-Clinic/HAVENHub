/**
 * My Info service: member-facing self-service mutations and queries.
 *
 * Every signed-in matched person (including alumni with no current term) can:
 *   - view their own contact details and active-term memberships
 *   - update five whitelisted contact fields (phone, contactEmail, epicId,
 *     yaleAffiliation, gradYear) -- never name or netId
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

import path from "node:path";
import fs from "node:fs/promises";
import type { HipaaCertificate } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { enqueueMirror } from "@/platform/outbox";
import { updatePersonFields, type PersonInput } from "@/platform/people";
import { config } from "@/platform/config";

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

/** The five fields a member is allowed to update for themselves. */
export type MyInfoInput = {
  phone?: string | null;
  contactEmail?: string | null;
  epicId?: string | null;
  yaleAffiliation?: string | null;
  gradYear?: string | null;
};

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Return the person, their ACTIVE memberships in the current ACTIVE term
 * (with term + department), and their latest HIPAA certificate.
 */
export async function getMyInfo(personId: string) {
  const [person, activeTerm] = await Promise.all([
    prisma.person.findUniqueOrThrow({ where: { id: personId } }),
    prisma.term.findFirst({
      where: { status: "ACTIVE" },
      orderBy: { startDate: "desc" },
    }),
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

  const latestCertificate = await prisma.hipaaCertificate.findFirst({
    where: { personId },
    orderBy: { uploadedAt: "desc" },
  });

  return { person, memberships, latestCertificate };
}

export async function listMyCertificates(personId: string): Promise<HipaaCertificate[]> {
  return prisma.hipaaCertificate.findMany({
    where: { personId },
    orderBy: { uploadedAt: "desc" },
  });
}

export async function getOwnedCertificate(
  personId: string,
  certId: string
): Promise<HipaaCertificate | null> {
  const cert = await prisma.hipaaCertificate.findUnique({ where: { id: certId } });
  if (!cert || cert.personId !== personId) return null;
  return cert;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Update the five whitelisted contact fields for the person identified by
 * personId. Extra keys in `input` (e.g. name, netId) are stripped here at the
 * service level before the platform call -- defense in depth beyond the form.
 *
 * Uses self as actor (actorPersonId === personId).
 */
export async function updateMyInfo(personId: string, input: MyInfoInput): Promise<void> {
  // Build a clean object containing ONLY the five allowed keys that are
  // present in the input. This is the service-level whitelist.
  const allowedKeys: Array<keyof MyInfoInput> = [
    "phone",
    "contactEmail",
    "epicId",
    "yaleAffiliation",
    "gradYear",
  ];

  const clean: MyInfoInput = {};
  for (const key of allowedKeys) {
    if (key in (input as object)) {
      clean[key] = (input as Record<string, unknown>)[key] as string | null | undefined;
    }
  }

  // PersonInput.name is typed as required for creates, but updatePersonFields
  // only updates keys present in the object (checked via "key in input"). A
  // my-info caller never supplies name, so this cast is safe: the platform
  // function will skip name entirely because it is absent from clean.
  await updatePersonFields(personId, personId, clean as unknown as PersonInput);
}

/**
 * Set the person's own ACTIVE VOLUNTEER memberships in the active term to
 * REMOVED. Returns the count of memberships withdrawn. When there are none,
 * returns 0 and does NOT write an audit row.
 *
 * DIRECTOR memberships are deliberately untouched: stepping down as a director
 * is a decision that goes through the executive directors.
 */
export async function withdrawFromTerm(personId: string): Promise<number> {
  const activeTerm = await prisma.term.findFirst({
    where: { status: "ACTIVE" },
    orderBy: { startDate: "desc" },
  });

  if (!activeTerm) return 0;

  const result = await prisma.termMembership.updateMany({
    where: {
      personId,
      termId: activeTerm.id,
      kind: "VOLUNTEER",
      status: "ACTIVE",
    },
    data: { status: "REMOVED" },
  });

  const count = result.count;
  if (count === 0) return 0;

  await recordAudit({
    actorPersonId: personId,
    action: "my-info.withdraw",
    entityType: "Person",
    entityId: personId,
    after: { termId: activeTerm.id, count },
  });

  return count;
}

/**
 * Validate, store, and record a HIPAA certificate upload.
 *
 * Order of operations (write-after-commit strategy):
 *   1. Validate (mime, extension, size)
 *   2. prisma.$transaction: create HipaaCertificate row + enqueueMirror
 *   3. AFTER commit: write bytes to UPLOAD_DIR/<cert.id>.pdf
 *   4. If disk write fails: delete the cert row (and its outbox row) and rethrow
 *   5. Audit my-info.certificate_upload (fileName + size only; never bytes)
 */
export async function saveCertificate(
  personId: string,
  file: { name: string; type: string; size: number; bytes: Buffer }
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
  const maxBytes = config.MAX_UPLOAD_MB * 1024 * 1024;
  if (file.size > maxBytes) {
    throw new CertificateValidationError(
      `File too large: ${file.size} bytes exceeds the ${config.MAX_UPLOAD_MB} MB limit`
    );
  }

  // --- 2. Transaction: create row + enqueue mirror ---
  const cert = await prisma.$transaction(async (tx) => {
    // The storedName is derived from the cert id; we need the id first.
    // Generate a placeholder and then derive; Prisma uses cuid by default.
    // Instead, create the row and use cert.id.
    const created = await tx.hipaaCertificate.create({
      data: {
        personId,
        fileName: file.name,
        // storedName is set after we have the id -- update in same tx
        storedName: "pending",
        size: file.size,
        mimeType: file.type,
      },
    });

    const storedName = `${created.id}.pdf`;

    const updated = await tx.hipaaCertificate.update({
      where: { id: created.id },
      data: { storedName },
    });

    await enqueueMirror(tx, {
      entityType: "HipaaCertificate",
      entityId: updated.id,
      changedFields: [],
    });

    return updated;
  });

  // --- 3. Write bytes to disk (after tx commits) ---
  const uploadDir = config.UPLOAD_DIR;
  const diskPath = path.join(uploadDir, cert.storedName);

  try {
    // mkdir -p on first use
    await fs.mkdir(uploadDir, { recursive: true });
    await fs.writeFile(diskPath, file.bytes);
  } catch (err) {
    // --- 4. Disk write failed: clean up the DB row and its outbox row ---
    // The outbox row was created in the transaction above; delete it too so the
    // drain worker cannot pick up a cert row that has no file on disk.
    try {
      await prisma.$transaction([
        prisma.outbox.deleteMany({
          where: { entityType: "HipaaCertificate", entityId: cert.id },
        }),
        prisma.hipaaCertificate.delete({ where: { id: cert.id } }),
      ]);
    } catch (cleanupErr) {
      console.error("[my-info] failed to clean up cert row after disk error", cert.id, cleanupErr);
    }
    throw err;
  }

  // --- 5. Audit (fileName + size; never bytes) ---
  await recordAudit({
    actorPersonId: personId,
    action: "my-info.certificate_upload",
    entityType: "HipaaCertificate",
    entityId: cert.id,
    after: { fileName: cert.fileName, size: cert.size },
  });

  return cert;
}
