/**
 * Backfill: bring cycles built before the non-Yale-affiliate fix onto the
 * identity format identitySection() now emits.
 *
 * The template only runs when a cycle is CREATED, so every cycle already in the
 * database still asks an applicant who answered "I am NOT a Yale Affiliate" for
 * a Yale NetID and a "Yale email" -- both required, so they cannot submit.
 *
 * Deliberately NOT scoped to DRAFT cycles the way backfillLanguageQuestion is.
 * That backfill ADDS a required question, which would strand an applicant
 * part-way through an OPEN cycle's form; this one only ever loosens (it removes
 * a requirement for a subset of applicants and relabels a field), so running it
 * on an OPEN cycle unblocks people rather than blocking them. ARCHIVED cycles
 * are still left alone: they should keep rendering the form as it was filled in.
 *
 * Every rule here mirrors the migration that ships alongside it
 * (20260818140000_apply_non_yale_identity_fields), so whichever runs second is a
 * no-op. Both are idempotent and both match on the seeded shape, so a field an
 * admin has customised is left alone.
 */

import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/platform/db";
import { NON_YALE_AFFILIATION } from "@/platform/affiliation";

/** The condition that hides -- and so also un-requires -- the NetID. */
export const NET_ID_VISIBLE_WHEN = {
  field: "yale_affiliation",
  op: "isNot",
  value: NON_YALE_AFFILIATION,
} as const;

/** The label the template used to seed, and the only one we will overwrite. */
const SEEDED_EMAIL_LABEL = "Yale email";
const NEW_EMAIL_LABEL = "Email address";
const NEW_EMAIL_HELP = "If you are a Yale affiliate, please use your Yale email address.";

const AFFILIATION_KEYS = ["yale_affiliation", "yale_affiliation_other"];

export type NonYaleIdentityReport = {
  cycleId: string;
  title: string;
  status: string;
  /** One human-readable line per change, empty when the cycle was already correct. */
  changes: string[];
  /** Set when the NetID could not be gated because the cycle asks no affiliation. */
  skippedGateReason?: string;
};

/**
 * New order values for one section, placing the affiliation pair immediately
 * before the NetID and leaving every other field's relative position alone.
 * Returns an empty map when nothing needs to move.
 *
 * Mirrors the migration's window function: sort by (the NetID's slot for the
 * affiliation pair, otherwise the field's own order), then affiliation ahead of
 * the NetID at that tie, then the original order as a stable tiebreak.
 */
export function reorderedFieldOrders(
  fields: Array<{ id: string; key: string; order: number }>,
): Map<string, number> {
  const netId = fields.find((f) => f.key === "net_id");
  const affiliation = fields.find((f) => f.key === "yale_affiliation");
  const result = new Map<string, number>();
  if (!netId || !affiliation || affiliation.order <= netId.order) return result;

  const sortKey = (f: { key: string; order: number }): [number, number, number] => [
    AFFILIATION_KEYS.includes(f.key) ? netId.order : f.order,
    f.key === "yale_affiliation" ? 0 : f.key === "yale_affiliation_other" ? 1 : 2,
    f.order,
  ];
  const sorted = [...fields].sort((a, b) => {
    const [a0, a1, a2] = sortKey(a);
    const [b0, b1, b2] = sortKey(b);
    return a0 - b0 || a1 - b1 || a2 - b2;
  });
  sorted.forEach((f, i) => { if (f.order !== i) result.set(f.id, i); });
  return result;
}

export async function backfillNonYaleIdentity(
  opts: { dryRun: boolean; cycleIds?: string[]; db?: PrismaClient } = { dryRun: true },
): Promise<NonYaleIdentityReport[]> {
  const db = opts.db ?? prisma;
  const cycles = await db.recruitmentCycle.findMany({
    where: {
      status: { not: "ARCHIVED" },
      ...(opts.cycleIds ? { id: { in: opts.cycleIds } } : {}),
    },
    select: {
      id: true, title: true, status: true,
      sections: {
        select: {
          id: true, title: true,
          fields: {
            select: { id: true, key: true, label: true, order: true, visibleWhen: true, helpText: true },
            orderBy: { order: "asc" },
          },
        },
        orderBy: { order: "asc" },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  const reports: NonYaleIdentityReport[] = [];

  for (const cycle of cycles) {
    const allFields = cycle.sections.flatMap((s) => s.fields.map((f) => ({ ...f, sectionId: s.id })));
    const netId = allFields.find((f) => f.key === "net_id");
    const email = allFields.find((f) => f.key === "email");
    const affiliation = allFields.find((f) => f.key === "yale_affiliation");
    if (!netId && !email) continue; // not an application form we recognise

    const report: NonYaleIdentityReport = {
      cycleId: cycle.id, title: cycle.title, status: cycle.status, changes: [],
    };

    // 1. Gate the NetID. Only where there is an affiliation question to key on:
    //    a condition pointing at a field that does not exist would silently
    //    resolve to "always visible" and read as done when it is not.
    const gateNetId = netId && affiliation && netId.visibleWhen == null;
    if (netId && !affiliation) {
      report.skippedGateReason = "cycle asks no yale_affiliation question";
    } else if (netId && netId.visibleWhen != null && !gateNetId) {
      report.skippedGateReason = `NetID already has its own condition: ${JSON.stringify(netId.visibleWhen)}`;
    }
    if (gateNetId) report.changes.push(`gate "${netId.label}" on ${JSON.stringify(NET_ID_VISIBLE_WHEN)}`);

    // 2. Relabel the email, matched on the exact seeded label so a cycle whose
    //    wording an admin already rewrote keeps theirs.
    const relabelEmail = email && email.label === SEEDED_EMAIL_LABEL;
    if (relabelEmail) {
      report.changes.push(
        `relabel email "${SEEDED_EMAIL_LABEL}" -> "${NEW_EMAIL_LABEL}"` +
        (email.helpText ? " (keeping existing help text)" : " + help text"),
      );
    }

    // 3. Lift the affiliation pair above the NetID it now controls.
    const reorders = new Map<string, number>();
    for (const section of cycle.sections) {
      const moved = reorderedFieldOrders(section.fields);
      if (moved.size > 0) {
        const before = section.fields.map((f) => f.key);
        const after = [...section.fields]
          .sort((a, b) => (moved.get(a.id) ?? a.order) - (moved.get(b.id) ?? b.order))
          .map((f) => f.key);
        report.changes.push(`reorder "${section.title}": ${before.join(", ")}  ->  ${after.join(", ")}`);
        for (const [id, order] of moved) reorders.set(id, order);
      }
    }

    if (!opts.dryRun && report.changes.length > 0) {
      await db.$transaction(async (tx) => {
        if (gateNetId) {
          await tx.formField.update({ where: { id: netId.id }, data: { visibleWhen: NET_ID_VISIBLE_WHEN } });
        }
        if (relabelEmail) {
          await tx.formField.update({
            where: { id: email.id },
            data: { label: NEW_EMAIL_LABEL, helpText: email.helpText ?? NEW_EMAIL_HELP },
          });
        }
        // Two passes: `order` is not unique, but shifting a field onto a value a
        // not-yet-moved sibling still holds would make an interleaved read see two
        // fields at the same position. Park them out of range first.
        for (const [id, order] of reorders) {
          await tx.formField.update({ where: { id }, data: { order: order + 1000 } });
        }
        for (const [id, order] of reorders) {
          await tx.formField.update({ where: { id }, data: { order } });
        }
      });
    }

    reports.push(report);
  }

  return reports;
}
