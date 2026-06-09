import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { recordAudit } from "@/platform/audit";
import { RecruitmentAuthError } from "./review";

export async function promoteContracts(contractIds: string[], actorId: string): Promise<{ created: number; reactivated: number; skipped: number }> {
  if (!(await can(actorId, "recruitment.review_all"))) throw new RecruitmentAuthError("Only SRR can promote onboarding contracts.");
  let created = 0, reactivated = 0, skipped = 0;

  for (const id of contractIds) {
    const contract = await prisma.onboardingContract.findUnique({
      where: { id },
      include: { acceptance: { include: { application: { include: { cycle: { select: { termId: true, track: true } } } } } } },
    });
    if (!contract || contract.status !== "SUBMITTED") { skipped += 1; continue; }
    const cycle = contract.acceptance.application.cycle;
    const dept = await prisma.department.findUnique({ where: { code: contract.acceptance.departmentCode } });
    if (!dept) { skipped += 1; continue; }
    const kind: "DIRECTOR" | "VOLUNTEER" = cycle.track === "DIRECTOR" ? "DIRECTOR" : "VOLUNTEER";

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
            },
          });
        }
        const effectiveEpicId = person.epicId ?? contract.existingEpicId ?? null;

        const existingMembership = await tx.termMembership.findFirst({ where: { personId: person.id, termId: cycle.termId, departmentId: dept.id, kind } });
        if (!existingMembership) {
          await tx.termMembership.create({ data: { personId: person.id, termId: cycle.termId, departmentId: dept.id, kind, status: "ACTIVE" } });
        }

        if (contract.hipaaStoredName) {
          const existingCert = await tx.hipaaCertificate.findFirst({ where: { personId: person.id, storedName: contract.hipaaStoredName } });
          if (!existingCert) {
            await tx.hipaaCertificate.create({
              data: {
                personId: person.id, fileName: contract.hipaaFileName ?? contract.hipaaStoredName, storedName: contract.hipaaStoredName,
                size: contract.hipaaSize ?? 0, mimeType: contract.hipaaMimeType ?? "application/octet-stream",
                completionDate: contract.hipaaCompletedAt, source: "IMPORT",
              },
            });
          }
        }

        if (contract.epicNeeded && !effectiveEpicId) {
          const openReq = await tx.epicRequest.findFirst({ where: { personId: person.id, status: { in: ["PENDING", "SUBMITTED"] } } });
          if (!openReq) {
            await tx.epicRequest.create({ data: { personId: person.id, kind: "NEW", requestedById: actorId } });
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
