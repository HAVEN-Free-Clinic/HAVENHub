import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { recordAudit } from "@/platform/audit";
import { findAcceptanceConflicts } from "../engine/conflicts";
import { RecruitmentAuthError } from "./review";

/**
 * Parse an applicant's "availability" answer -- an array of YYYY-MM-DD clinic-date
 * values from the application's MULTI_SELECT (see templates/field-groups.ts
 * availabilitySection and templates/term-dates.ts) -- into UTC-midnight Dates for
 * TermMembership.baselineAvailability. The scheduler resolves availability tiers
 * (director > self > baseline) and compares every date by UTC day key, so baseline
 * dates must be stored as UTC midnight to line up with the term's clinic dates.
 * Tolerant of a scalar string (a single MULTI_SELECT checkbox serializes to one),
 * missing/empty answers, duplicates, and malformed values.
 */
export function parseAvailabilityDates(answer: unknown): Date[] {
  const raw = Array.isArray(answer) ? answer : answer == null || answer === "" ? [] : [answer];
  const out: Date[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const key = v.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || seen.has(key)) continue;
    const d = new Date(`${key}T00:00:00.000Z`);
    if (Number.isNaN(d.getTime())) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

export async function promoteContracts(contractIds: string[], actorId: string): Promise<{ created: number; reactivated: number; skipped: number }> {
  if (!(await can(actorId, "recruitment.review_all"))) throw new RecruitmentAuthError("Only SRR can promote onboarding contracts.");
  let created = 0, reactivated = 0, skipped = 0;

  for (const id of contractIds) {
    const contract = await prisma.onboardingContract.findUnique({
      where: { id },
      include: { acceptance: { include: { application: { include: { cycle: { select: { termId: true, track: true } }, acceptances: { select: { departmentCode: true } } } } } } },
    });
    if (!contract || contract.status !== "SUBMITTED") { skipped += 1; continue; }
    // Never promote a conflicted acceptance: one application accepted by more
    // than one department would otherwise land the person on two rosters. SRR
    // must resolve the conflict on the Decisions page first.
    const application = contract.acceptance.application;
    const conflicts = findAcceptanceConflicts(
      application.acceptances.map((a) => ({ applicationId: application.id, departmentCode: a.departmentCode })),
    );
    if (conflicts.has(application.id)) { skipped += 1; continue; }
    const cycle = application.cycle;
    const dept = await prisma.department.findUnique({ where: { code: contract.acceptance.departmentCode } });
    if (!dept) { skipped += 1; continue; }
    const kind: "DIRECTOR" | "VOLUNTEER" = cycle.track === "DIRECTOR" ? "DIRECTOR" : "VOLUNTEER";
    // Carry the availability the applicant chose on their application into the
    // scheduler's baseline tier. Without this the member lands with empty
    // baselineAvailability and the schedule builder shows them available on zero
    // clinic dates despite having answered the application's availability question.
    const availabilityDates = parseAvailabilityDates(
      (application.answers as Record<string, unknown> | null | undefined)?.["availability"],
    );

    try {
      const wasNew = await prisma.$transaction(async (tx) => {
        let person = contract.netId
          ? await tx.person.findFirst({ where: { netId: { equals: contract.netId, mode: "insensitive" } } })
          : null;
        if (!person && contract.email) {
          person = await tx.person.findFirst({ where: { contactEmail: { equals: contract.email, mode: "insensitive" } } });
        }
        let isNew = false;
        if (person) {
          await tx.person.update({
            where: { id: person.id },
            data: {
              status: "ACTIVE",
              phone: person.phone ?? contract.phone,
              yaleAffiliation: person.yaleAffiliation ?? contract.yaleAffiliation,
              gradYear: person.gradYear ?? contract.gradYear,
              epicId: person.epicId ?? contract.existingEpicId,
              spanishSelfReported: person.spanishSelfReported || contract.spanishSelfReported,
              licensedRN: person.licensedRN || contract.licensedRN,
              // Carry onboarding-collected member data (don't clobber an existing value).
              dateOfBirth: person.dateOfBirth ?? contract.dateOfBirth,
              dietaryRestrictions: person.dietaryRestrictions ?? contract.dietaryRestrictions,
            },
          });
        } else {
          isNew = true;
          person = await tx.person.create({
            data: {
              name: `${contract.firstName} ${contract.lastName}`.trim(),
              netId: contract.netId, contactEmail: contract.email, phone: contract.phone,
              yaleAffiliation: contract.yaleAffiliation, gradYear: contract.gradYear,
              epicId: contract.existingEpicId, status: "ACTIVE",
              spanishSelfReported: contract.spanishSelfReported,
              licensedRN: contract.licensedRN,
              dateOfBirth: contract.dateOfBirth,
              dietaryRestrictions: contract.dietaryRestrictions,
            },
          });
        }
        const effectiveEpicId = person.epicId ?? contract.existingEpicId ?? null;

        const existingMembership = await tx.termMembership.findFirst({ where: { personId: person.id, termId: cycle.termId, departmentId: dept.id, kind } });
        if (!existingMembership) {
          await tx.termMembership.create({ data: { personId: person.id, termId: cycle.termId, departmentId: dept.id, kind, status: "ACTIVE", baselineAvailability: availabilityDates } });
        } else if (existingMembership.status === "REMOVED") {
          // Offboarding flips a membership to REMOVED rather than deleting it (see
          // offboard convergence). A person who was previously removed and is now
          // re-promoted keeps that stale REMOVED row, so without this they land as
          // Person.status ACTIVE but absent from every ACTIVE-keyed roster,
          // scheduler, and compliance surface (audit3 M1). Reactivate it; an
          // already-ACTIVE membership is left untouched. Refresh baseline
          // availability from the fresh application (only when it supplied one, so
          // we never wipe an existing baseline with an empty answer).
          await tx.termMembership.update({
            where: { id: existingMembership.id },
            data: { status: "ACTIVE", ...(availabilityDates.length > 0 ? { baselineAvailability: availabilityDates } : {}) },
          });
        }

        if (contract.hipaaStoredName) {
          // submitContract stored the bytes under "onboarding/<contractId>/<storedName>".
          // Point the cert at that exact key so the download route can resolve it;
          // the contract is retained (PROMOTED, never deleted), so the object persists.
          const certStoredName = `onboarding/${contract.id}/${contract.hipaaStoredName}`;
          const existingCert = await tx.hipaaCertificate.findFirst({ where: { personId: person.id, storedName: certStoredName } });
          if (!existingCert) {
            await tx.hipaaCertificate.create({
              data: {
                personId: person.id, fileName: contract.hipaaFileName ?? contract.hipaaStoredName, storedName: certStoredName,
                size: contract.hipaaSize ?? 0, mimeType: contract.hipaaMimeType ?? "application/octet-stream",
                completionDate: contract.hipaaCompletedAt, source: "IMPORT",
              },
            });
          }
        }

        if (contract.epicNeeded && !effectiveEpicId) {
          const openReq = await tx.epicRequest.findFirst({ where: { personId: person.id, status: { in: ["PENDING", "SUBMITTED"] } } });
          if (!openReq) {
            // Carry the applicant's Epic access details onto the request so whoever
            // provisions it in YNHH sees them (the applicant supplied them at onboarding).
            const epicNotes = [
              contract.epicAccessType ? `Access type: ${contract.epicAccessType}` : null,
              contract.worksWithYnhh ? "Already works with YNHH" : null,
            ].filter(Boolean).join(". ") || null;
            await tx.epicRequest.create({ data: { personId: person.id, kind: "NEW", requestedById: actorId, notes: epicNotes } });
          }
        }

        await tx.onboardingContract.update({ where: { id: contract.id }, data: { status: "PROMOTED", promotedAt: new Date(), promotedById: actorId, promotedPersonId: person.id } });
        return isNew;
      });
      if (wasNew) created += 1; else reactivated += 1;
      await recordAudit({ actorPersonId: actorId, action: "recruitment.promote", entityType: "OnboardingContract", entityId: id });
    } catch (err) {
      console.error("[promotion] skipping contract", id, err);
      skipped += 1;
    }
  }
  return { created, reactivated, skipped };
}
