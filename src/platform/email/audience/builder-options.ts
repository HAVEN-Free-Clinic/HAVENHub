/**
 * Option lists for the AudienceBuilder, shared by the campaign editor and the
 * audience-scope editor.
 *
 * The non-obvious part is the union with referenced-but-missing values. A stored
 * condition naming a department, term or cycle that was later deactivated or
 * deleted has no option in the active-only list, so it renders as neither
 * checked nor uncheckable while still serialising into every save and filtering
 * forever. Every list below therefore unions in whatever the stored audience
 * references, labelled so it can be recognised and removed (#82).
 */
import { prisma } from "@/platform/db";
import { collectAudienceReferences } from "./references";
import type { Audience } from "./types";

export type AudienceBuilderOptions = {
  departments: { code: string; name: string }[];
  terms: { id: string; label: string }[];
  cycles: { id: string; label: string }[];
  subcommittees: { id: string; label: string }[];
};

export async function loadAudienceBuilderOptions(
  audience: Audience,
): Promise<AudienceBuilderOptions> {
  const [departments, terms, cycles, subcommittees] = await Promise.all([
    prisma.department.findMany({
      where: { isActive: true },
      select: { code: true, name: true },
      orderBy: { code: "asc" },
    }),
    // EVERY term, archived included -- unlike the RBAC term picker, which hides
    // archived terms because an assignment scoped to one is permanently inert.
    // Here a past term is the whole point: "email everyone who volunteered in
    // spring" is a question about a roster that is now archived.
    prisma.term.findMany({
      select: { id: true, code: true, name: true, status: true },
      orderBy: { startDate: "desc" },
    }),
    prisma.recruitmentCycle.findMany({
      select: { id: true, title: true, status: true },
      orderBy: { createdAt: "desc" },
    }),
    prisma.subcommittee.findMany({
      where: { isActive: true },
      select: { id: true, name: true },
      orderBy: { order: "asc" },
    }),
  ]);

  const referenced = collectAudienceReferences(audience.conditions);

  const activeCodes = new Set(departments.map((d) => d.code));
  const missingCodes = [...referenced.departmentCodes].filter((c) => !activeCodes.has(c));
  const inactiveReferenced = missingCodes.length
    ? await prisma.department.findMany({
        where: { code: { in: missingCodes } },
        select: { code: true, name: true },
        orderBy: { code: "asc" },
      })
    : [];
  const foundCodes = new Set(inactiveReferenced.map((d) => d.code));

  // Subcommittees get the department treatment (an isActive flag, not a status
  // enum), rather than the cycle treatment: a referenced-but-deactivated
  // subcommittee still exists as a row and is labelled "(inactive)", distinct
  // from one with no surviving row at all ("(removed)").
  const activeSubIds = new Set(subcommittees.map((s) => s.id));
  const missingSubIds = [...referenced.subcommitteeIds].filter((id) => !activeSubIds.has(id));
  const inactiveReferencedSubs = missingSubIds.length
    ? await prisma.subcommittee.findMany({
        where: { id: { in: missingSubIds } },
        select: { id: true, name: true },
        orderBy: { order: "asc" },
      })
    : [];
  const foundSubIds = new Set(inactiveReferencedSubs.map((s) => s.id));

  return {
    departments: [
      ...departments,
      ...inactiveReferenced.map((d) => ({ code: d.code, name: `${d.name} (inactive)` })),
      // Codes with no surviving Department row at all (department fully
      // deleted): still render them so the admin can uncheck the dead value.
      ...missingCodes
        .filter((c) => !foundCodes.has(c))
        .map((c) => ({ code: c, name: `${c} (removed)` })),
    ],
    // Terms and cycles get the same treatment as departments above: a stored
    // audience naming a deleted term or cycle must stay visible and removable
    // rather than becoming an invisible filter nobody can edit out.
    terms: [
      ...terms.map((t) => ({
        id: t.id,
        label: t.status === "ACTIVE" ? `${t.code} (current)` : `${t.code} - ${t.name}`,
      })),
      ...[...referenced.termIds]
        .filter((tid) => !terms.some((t) => t.id === tid))
        .map((tid) => ({ id: tid, label: "Deleted term" })),
    ],
    cycles: [
      ...cycles.map((c) => ({
        id: c.id,
        label: c.status === "OPEN" ? `${c.title} (open)` : c.title,
      })),
      ...[...referenced.cycleIds]
        .filter((cid) => !cycles.some((c) => c.id === cid))
        .map((cid) => ({ id: cid, label: "Deleted cycle" })),
    ],
    subcommittees: [
      ...subcommittees.map((s) => ({ id: s.id, label: s.name })),
      ...inactiveReferencedSubs.map((s) => ({ id: s.id, label: `${s.name} (inactive)` })),
      // Ids with no surviving Subcommittee row at all (fully deleted): still
      // render them so the admin can uncheck the dead value.
      ...missingSubIds
        .filter((id) => !foundSubIds.has(id))
        .map((id) => ({ id, label: "Deleted subcommittee" })),
    ],
  };
}
