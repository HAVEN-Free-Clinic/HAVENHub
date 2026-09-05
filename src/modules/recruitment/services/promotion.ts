import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { recordAudit } from "@/platform/audit";
import { claimLanguage, notifyReviewersOfPendingClaims } from "@/platform/languages";
import { log, errorAttrs } from "@/platform/logging";
import { aliasPerson, flushEvents } from "@/platform/posthog/capture";
import {
  AVAILABILITY_FIELD_KEY,
  applicationAvailabilityDates,
  parseAvailabilityDates,
} from "@/platform/recruitment/incoming-roster";
import { cancelOpenDeactivationRequestsTx } from "@/platform/people";
import { isNetIdShaped } from "@/platform/auth/match-person";
import { normalizeIdentityKey } from "./identity-keys";
import { findAcceptanceConflicts } from "../engine/conflicts";
import { RecruitmentAuthError } from "./review";
import { linkAttendanceByEmail } from "./attendance-events";

/** Thrown when another promote claimed the contract first. Benign: counted as skipped. */
class ContractAlreadyClaimedError extends Error {
  constructor(public contractId: string) {
    super(`Onboarding contract ${contractId} was already promoted`);
    this.name = "ContractAlreadyClaimedError";
  }
}

export async function promoteContracts(
  contractIds: string[],
  actorId: string
): Promise<{ created: number; reactivated: number; skipped: number; failed: number }> {
  if (!(await can(actorId, "recruitment.review_all"))) throw new RecruitmentAuthError("Only SRR can promote onboarding contracts.");
  let created = 0, reactivated = 0, skipped = 0, failed = 0;
  // Pre-conversion apply-portal events were keyed by the applicant email; alias
  // each into the resolved person id so those events join the person timeline.
  let aliasedAny = false;
  // New language claims across every promoted contract, sent as ONE digest per
  // reviewer once the whole batch has committed.
  const pendingLanguageClaims: Array<{ personId: string; language: string }> = [];

  for (const id of contractIds) {
    const contract = await prisma.onboardingContract.findUnique({
      where: { id },
      include: { acceptance: { include: { application: { include: { cycle: { select: { termId: true, track: true, term: { select: { clinicDates: true } } } }, acceptances: { select: { departmentCode: true } } } } } } },
    });
    if (!contract || contract.status !== "SUBMITTED") { skipped += 1; continue; }
    // A withdrawn applicant must never reach the roster. Withdrawal deliberately
    // leaves the acceptance and contract intact (tearing them down would cascade
    // away signatures, DOB, and the HIPAA cert), so the contract still looks
    // promotable and nothing else downstream would catch this.
    if (contract.acceptance.application.status === "WITHDRAWN") { skipped += 1; continue; }
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
    //
    // Both helpers are the platform ones the SCHEDULE BUILDER also reads this
    // answer through, to show a not-yet-promoted acceptance's availability. If
    // the two parsed it differently, a person's available dates would shift the
    // moment they were promoted and invalidate a schedule drafted around them.
    //
    // The reactivation guard below stays on the PRE-filter parse: it asks "did
    // they answer the question at all", which an answer of nothing but stale
    // non-clinic dates still did.
    const parsedAvailabilityDates = parseAvailabilityDates(
      (application.answers as Record<string, unknown> | null | undefined)?.[AVAILABILITY_FIELD_KEY],
    );
    const availabilityDates = applicationAvailabilityDates(
      application.answers,
      cycle.term.clinicDates,
    );

    let wasReactivated = false;
    let cancelledDeactivations: string[] = [];
    try {
      const result = await prisma.$transaction(async (tx) => {
        // Claim the contract before doing any work. The SUBMITTED guard above is
        // a read outside this transaction, and the terminal write used to carry
        // no precondition, so two SRRs promoting the same contract at once could
        // both proceed: for a returning applicant whose membership already exists
        // neither hits a unique key, and both then create a HipaaCertificate and
        // an EpicRequest (neither table constrains duplicates). Claiming first
        // makes the loser roll back before creating anything. Mirrors the
        // updateMany claim used by the other terminal transitions in this module.
        const claimed = await tx.onboardingContract.updateMany({
          where: { id: contract.id, status: "SUBMITTED" },
          data: { status: "PROMOTED", promotedAt: new Date(), promotedById: actorId },
        });
        if (claimed.count === 0) throw new ContractAlreadyClaimedError(contract.id);

        // Re-read inside the transaction: a withdrawal committing between the
        // guard above and this claim must abort the promotion, not race it.
        // ContractAlreadyClaimedError is the benign "counted as skipped" path,
        // and rolling back here un-does the claim we just made.
        const withdrawn = await tx.application.count({
          where: { id: contract.acceptance.applicationId, status: "WITHDRAWN" },
        });
        if (withdrawn > 0) throw new ContractAlreadyClaimedError(contract.id);

        // Normalize the applicant-typed identity to the codebase-wide invariant
        // (trimmed + lowercase, empty -> null) before matching OR writing. Every
        // other Person write goes through people.ts normalize(); promotion creates
        // the Person directly, so a raw " JC123 " would be stored with casing and
        // whitespace that no login lookup (case-insensitive but whitespace-sensitive)
        // could match, and would defeat the lower(netId) unique index. Trimming the
        // match key also stops a whitespace-padded contract value from missing an
        // existing person and minting a duplicate.
        const normNetId = normalizeIdentityKey(contract.netId);
        const normEmail = normalizeIdentityKey(contract.email);

        // What may be WRITTEN into Person.netId is a narrower question than what
        // may be matched on. isNetIdShaped is documented as "the single
        // definition, so the login path and anything WRITING Person.netId agree
        // on what belongs in that column" -- and every Airtable import path
        // applies it. Promotion, now the primary production path that creates a
        // Person, did not: the value is the applicant's own keystrokes in a plain
        // SHORT_TEXT field with no regex, so an email address or free text landed
        // in the column that feeds the YNHH Epic access PDF and the Teams removal
        // CSV (audit 14, ONB-3).
        //
        // Still MATCHED on the raw-normalized value above, so a padded but valid
        // NetID still finds its existing Person; only the write is gated.
        const writableNetId = normNetId && isNetIdShaped(normNetId) ? normNetId : null;

        let person = normNetId
          ? await tx.person.findFirst({ where: { netId: { equals: normNetId, mode: "insensitive" } } })
          : null;
        if (!person && normEmail) {
          person = await tx.person.findFirst({ where: { contactEmail: { equals: normEmail, mode: "insensitive" } } });
        }
        let isNew = false;
        if (person) {
          // Offboard convergence: this is a reactivation path for anyone whose
          // Person.status was OFFBOARDED (offboarded people fail the Entra match
          // at sign-in, so they return as a NEW applicant and land here). Flipping
          // the status alone left the PENDING DEACTIVATE EpicRequest that
          // offboarding queued still open, so the person stayed in IT's
          // deactivation queue and had their Epic access revoked days after
          // re-joining. Mirror setPersonStatusField's ACTIVE branch, in the same
          // transaction, via the helper both paths now share.
          if (person.status !== "ACTIVE") {
            cancelledDeactivations = await cancelOpenDeactivationRequestsTx(tx, person.id);
            wasReactivated = true;
          }
          await tx.person.update({
            where: { id: person.id },
            data: {
              status: "ACTIVE",
              phone: person.phone ?? contract.phone,
              yaleAffiliation: person.yaleAffiliation ?? contract.yaleAffiliation,
              gradYear: person.gradYear ?? contract.gradYear,
              epicId: person.epicId ?? contract.existingEpicId,
              licensedRN: person.licensedRN || contract.licensedRN,
              // Carry onboarding-collected member data (don't clobber an existing value).
              dateOfBirth: person.dateOfBirth ?? contract.dateOfBirth,
              dietaryRestrictions: person.dietaryRestrictions ?? contract.dietaryRestrictions,
              pronouns: person.pronouns ?? contract.pronouns,
              staffTitle: person.staffTitle ?? contract.staffTitle,
            },
          });
        } else {
          isNew = true;
          person = await tx.person.create({
            data: {
              name: `${contract.firstName} ${contract.lastName}`.trim(),
              netId: writableNetId, contactEmail: normEmail, phone: contract.phone,
              yaleAffiliation: contract.yaleAffiliation, gradYear: contract.gradYear,
              epicId: contract.existingEpicId, status: "ACTIVE",
              licensedRN: contract.licensedRN,
              dateOfBirth: contract.dateOfBirth,
              dietaryRestrictions: contract.dietaryRestrictions,
              pronouns: contract.pronouns,
              staffTitle: contract.staffTitle,
            },
          });
        }
        const effectiveEpicId = person.epicId ?? contract.existingEpicId ?? null;

        // Language claims become self-reported PersonLanguage rows, which is
        // what puts the new member into the interpreting department's review
        // queue. These are CLAIMS: nothing here marks anything verified, so they
        // gate no scheduling until a human assesses them.
        //
        // Two sources, unioned:
        //   - the APPLICATION's standard language question (any language), and
        //   - the onboarding contract's Spanish checkbox, kept because it is a
        //     separate later statement and an applicant may have skipped the
        //     application question.
        const claimedLanguages = new Set<string>(application?.languagesClaimed ?? []);
        if (contract.spanishSelfReported) claimedLanguages.add("es");
        // Only claims that did not already exist are worth telling the
        // interpreting department about; a returning member re-stating a
        // language already on their record is not new work for a reviewer.
        // Collected here and sent after the loop: notifying from inside this
        // transaction stretched it across a permission resolution plus a
        // notification write per reviewer, and mailed them about promotions
        // that then rolled back.
        const newClaims: Array<{ personId: string; language: string }> = [];
        for (const code of claimedLanguages) {
          const { created } = await claimLanguage(person.id, code, tx);
          if (created) newClaims.push({ personId: person.id, language: code });
        }

        // One ACTIVE membership per (person, term, department) is the intended
        // state: changeMembershipKind soft-removes the old row when swapping
        // kinds. Promotion used to scope its lookup by `kind` too, so promoting
        // someone through a DIRECTOR cycle who already held an ACTIVE VOLUNTEER
        // row in the same department created a parallel ACTIVE row. That renders
        // them as two rows in the schedule builder grid (sharing one personId, so
        // both toggle the same assignment) and double-counts them in department
        // compliance. Retire any ACTIVE row of the other kind first.
        const otherKindActive = await tx.termMembership.findMany({
          where: {
            personId: person.id, termId: cycle.termId, departmentId: dept.id,
            status: "ACTIVE", kind: { not: kind },
          },
          select: { id: true },
        });
        for (const m of otherKindActive) {
          await tx.termMembership.update({ where: { id: m.id }, data: { status: "REMOVED" } });
        }

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
          // availability from the fresh application, but only when the application
          // actually supplied an availability answer (checked on the PARSED list,
          // before the clinic-date filter): an application with no availability
          // answer at all must not wipe an existing baseline. If the applicant did
          // answer but every date they picked has since fallen off the clinic
          // calendar (or was a phantom Saturday from before this filter existed),
          // write the empty FILTERED list so the stale dates don't linger, matching
          // the create path above.
          await tx.termMembership.update({
            where: { id: existingMembership.id },
            data: { status: "ACTIVE", ...(parsedAvailabilityDates.length > 0 ? { baselineAvailability: availabilityDates } : {}) },
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

        // The status/promotedAt/promotedById half was written by the claim above.
        await tx.onboardingContract.update({ where: { id: contract.id }, data: { promotedPersonId: person.id } });
        return { isNew, personId: person.id, newClaims };
      });
      if (result.isNew) created += 1; else reactivated += 1;
      pendingLanguageClaims.push(...result.newClaims);
      await recordAudit({ actorPersonId: actorId, action: "recruitment.promote", entityType: "OnboardingContract", entityId: id });
      // Bringing a Person back to ACTIVE is auditable wherever it happens. The
      // recruitment.promote row above is against the contract, so without this a
      // reactivation via re-onboarding left no trace on the Person, unlike the
      // same change made from /admin/people. Same action name and shape as
      // setPersonStatusField's reactivate branch.
      if (wasReactivated) {
        await recordAudit({
          actorPersonId: actorId,
          action: "person.reactivate",
          entityType: "Person",
          entityId: result.personId,
          before: { status: "OFFBOARDED" },
          after: { status: "ACTIVE", cancelledDeactivationRequestIds: cancelledDeactivations },
        });
      }
      if (contract.email) {
        await aliasPerson({ personId: result.personId, previousDistinctId: contract.email, flush: false });
        aliasedAny = true;
        // This is the moment an event walk-up stops being an orphan: they were
        // checked in at an info session or a training by name and email, and the
        // Person that email belongs to now exists. Linking here backfills any
        // training completion that attendance implies, so someone who sat through
        // training before onboarding is not asked to attend it again.
        //
        // OUTSIDE the transaction and best-effort, deliberately: a failure here
        // must not roll back a promotion (a Postgres error inside a transaction
        // poisons the whole connection, whatever the try/catch says), and the
        // nudge cron's relink sweep picks up anything missed.
        try {
          const linked = await linkAttendanceByEmail(result.personId, contract.email);
          if (linked > 0) {
            log.info("[promotion] linked prior event attendance", {
              personId: result.personId,
              linked,
            });
          }
        } catch (err) {
          log.error("[promotion] attendance link failed", errorAttrs(err, { contractId: id }));
        }
      }
    } catch (err) {
      if (err instanceof ContractAlreadyClaimedError) {
        // Another promote won the race. Benign, and the winner did the work.
        skipped += 1;
        continue;
      }
      // Anything else is a real failure (transaction timeout, constraint
      // violation, dropped connection) and must NOT be folded into `skipped`,
      // which the SRR reads as "conflicted or not yet submitted" and dismisses.
      // Those people would otherwise never be created, never get a membership,
      // and be absent from every roster for the term with nobody aware.
      log.error("[promotion] contract failed to promote", errorAttrs(err, { contractId: id }));
      failed += 1;
    }
  }
  if (aliasedAny) await flushEvents();
  // After every transaction has committed. Best-effort inside: a delivery
  // failure must not read as a failed promotion.
  await notifyReviewersOfPendingClaims(pendingLanguageClaims, actorId);
  return { created, reactivated, skipped, failed };
}
