/**
 * Loads the mapped support history into the database.
 *
 * Two invariants make this safe to point at production:
 *
 *   1. NO NOTIFICATIONS. Every write here goes through prisma directly. It
 *      never calls a src/modules/support service, so it can never reach
 *      notify() or queueEmail(). runSupportHistoryImport asserts this by
 *      counting EmailLog/TeamsMessage/Notification rows before and after and
 *      failing loudly if any moved. The imported rows are also inert: no cron
 *      route reads TechRequest, YnhhTicket or EpicRequest.
 *
 *   2. NO DELETES, AND RE-RUNNABLE. Every row is keyed on its Airtable
 *      provenance (TechRequest.airtableRecordId, YnhhTicket.airtableRecordId
 *      or serviceRequestNumber, EpicRequest.techRequestId), so a second run
 *      updates what it wrote the first time rather than duplicating it.
 *
 * The one place this touches rows it did not create is the strict tracker
 * merge; see findMergeTarget for why that rule is deliberately narrow.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  transformTechRequests,
  transformTrackerTickets,
  resolveTrackerPersonName,
  inferTrackerKind,
  epicIntakeNote,
  type MappedTechRequest,
} from "./transform";

/** Widest window between an Airtable tracker row and a hub ticket for the same request. */
const MERGE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export type PersonRef = { id: string; name: string; airtableRecordId: string | null };

export type ExistingTicket = {
  id: string;
  serviceRequestNumber: string | null;
  submittedAt: Date;
  requests: Array<{ personId: string }>;
};

/**
 * Decides whether a tracker row describes a YNHH ticket the hub already
 * recorded natively, rather than a new one.
 *
 * The hub's Epic flow went live on 2026-06-16 while the Airtable tracker kept
 * being filled in, so a window of tickets exists in both places. The rule is
 * deliberately strict: the candidate must carry no Service Request number yet
 * (so we only ever add information), must already link an Epic request for
 * exactly the person the tracker row names, and must sit within two weeks of
 * it. A looser rule matching on description text alone would mis-merge, and a
 * wrong merge silently attributes an Epic account to the wrong person.
 */
export function findMergeTarget(
  candidates: ExistingTicket[],
  personId: string,
  submittedAt: Date,
  claimed: Set<string>,
): ExistingTicket | null {
  const matches = candidates.filter(
    (c) =>
      !claimed.has(c.id) &&
      c.serviceRequestNumber === null &&
      c.requests.some((r) => r.personId === personId) &&
      Math.abs(+c.submittedAt - +submittedAt) <= MERGE_WINDOW_MS,
  );
  // Ambiguity is not a merge: two equally good candidates means we cannot tell
  // which real ticket this is, so it becomes a new row and shows up in the report.
  return matches.length === 1 ? matches[0] : null;
}

export type SupportHistoryReport = {
  dryRun: boolean;
  techRequests: { created: number; updated: number };
  epicRequests: { created: number; updated: number };
  ynhhTickets: { createdFromTickets: number; createdFromTracker: number; mergedIntoExisting: number };
  attachments: { uploaded: number; alreadyPresent: number; failed: number; skipped: boolean };
  /** Airtable rows that could not be mapped, with the reason. Expected to be empty. */
  skipped: Array<{ source: string; recordId: string; reason: string }>;
  /** Tracker rows whose subject could not be resolved to exactly one Person. */
  unresolvedTrackerNames: Array<{ recordId: string; text: string }>;
  /**
   * Existing hub YnhhTickets with no linked Epic request and no service request
   * number. Reported only; the import never touches them.
   */
  contentFreeExistingTickets: number;
  nextTechRequestNumber: number | null;
};

export type LoadOptions = {
  dryRun: boolean;
  skipAttachments: boolean;
  /** Injected so tests can drive attachment download without network access. */
  fetchImpl?: typeof fetch;
  putObject?: (key: string, bytes: Buffer, contentType: string) => Promise<void>;
};

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Resolves the people a run needs, up front and in bulk: requesters and
 * assignees by Airtable record id, tracker submitters and subjects by name.
 */
export async function loadPeople(db: Db): Promise<{
  byAirtableId: Map<string, PersonRef>;
  byName: Map<string, PersonRef[]>;
  names: string[];
}> {
  const people = await db.person.findMany({
    select: { id: true, name: true, airtableRecordId: true },
  });
  const byAirtableId = new Map<string, PersonRef>();
  const byName = new Map<string, PersonRef[]>();
  for (const p of people) {
    if (p.airtableRecordId) byAirtableId.set(p.airtableRecordId, p);
    const key = p.name.toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), p]);
  }
  return { byAirtableId, byName, names: people.map((p) => p.name) };
}

/** Resolves a name to exactly one Person, or null when absent or ambiguous. */
function personByName(byName: Map<string, PersonRef[]>, name: string | null): PersonRef | null {
  if (!name) return null;
  const hits = byName.get(name.toLowerCase()) ?? [];
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Builds the YNHH tickets implied by the RITM numbers typed inline on tech
 * requests. These predate the tracker table and never collide with it (the two
 * number ranges are disjoint), so each distinct number becomes one ticket
 * covering every tech request that names it.
 */
function planTicketsFromTechRequests(
  rows: MappedTechRequest[],
): Map<string, { description: string; submittedAt: Date; closedAt: Date | null; sources: MappedTechRequest[] }> {
  const byNumber = new Map<
    string,
    { description: string; submittedAt: Date; closedAt: Date | null; sources: MappedTechRequest[] }
  >();
  for (const row of rows) {
    if (!row.serviceRequestNumber) continue;
    const existing = byNumber.get(row.serviceRequestNumber);
    if (existing) {
      existing.sources.push(row);
      existing.description = existing.sources.map((s) => s.subject).join("; ");
      if (row.createdAt < existing.submittedAt) existing.submittedAt = row.createdAt;
      if (row.resolvedAt && (!existing.closedAt || row.resolvedAt > existing.closedAt)) {
        existing.closedAt = row.resolvedAt;
      }
    } else {
      byNumber.set(row.serviceRequestNumber, {
        description: row.subject,
        submittedAt: row.createdAt,
        closedAt: row.resolvedAt,
        sources: [row],
      });
    }
  }
  return byNumber;
}

export type ImportInput = {
  techRecords: Array<{ id: string; fields: Record<string, unknown>; createdTime?: string }>;
  trackerRecords: Array<{ id: string; fields: Record<string, unknown>; createdTime?: string }>;
};

/**
 * Writes the whole import. Callers pass a transaction client so that a failure
 * anywhere leaves the database untouched; attachments are uploaded separately,
 * afterwards, because object storage is not transactional.
 */
export async function loadSupportHistory(
  db: Db,
  input: ImportInput,
  options: LoadOptions,
): Promise<{ report: SupportHistoryReport; attachmentWork: Array<{ requestId: string; row: MappedTechRequest }> }> {
  const report: SupportHistoryReport = {
    dryRun: options.dryRun,
    techRequests: { created: 0, updated: 0 },
    epicRequests: { created: 0, updated: 0 },
    ynhhTickets: { createdFromTickets: 0, createdFromTracker: 0, mergedIntoExisting: 0 },
    attachments: { uploaded: 0, alreadyPresent: 0, failed: 0, skipped: options.skipAttachments },
    skipped: [],
    unresolvedTrackerNames: [],
    contentFreeExistingTickets: 0,
    nextTechRequestNumber: null,
  };

  const { byAirtableId, byName, names } = await loadPeople(db);
  const tech = transformTechRequests(input.techRecords);
  const tracker = transformTrackerTickets(input.trackerRecords);
  report.skipped.push(
    ...tech.skipped.map((s) => ({ source: "Tech Requests", recordId: s.recordId, reason: s.reason })),
  );

  const existingTickets: ExistingTicket[] = await db.ynhhTicket.findMany({
    select: {
      id: true,
      serviceRequestNumber: true,
      submittedAt: true,
      requests: { select: { personId: true } },
    },
  });
  report.contentFreeExistingTickets = existingTickets.filter(
    (t) => t.requests.length === 0 && t.serviceRequestNumber === null,
  ).length;

  // Service request number -> YnhhTicket.id, populated as tickets are created
  // so tech requests can link to the ticket their inline RITM names.
  const ticketIdByNumber = new Map<string, string>();
  const claimed = new Set<string>();

  // --- YNHH tickets implied by inline RITM numbers on tech requests ---------
  for (const [number, plan] of planTicketsFromTechRequests(tech.rows)) {
    const existing = await db.ynhhTicket.findFirst({ where: { serviceRequestNumber: number } });
    // These rows record work an assignee did with YNHH, so the assignee is the
    // submitter; every source row carrying an inline RITM has one.
    const submitter =
      plan.sources.map((s) => s.assignedToRecordId).find(Boolean) ?? plan.sources[0].requesterRecordId;
    const submittedBy = submitter ? byAirtableId.get(submitter) : null;
    if (!submittedBy) {
      report.skipped.push({
        source: "YNHH (from tech request)",
        recordId: number,
        reason: "submitter does not resolve to a Person",
      });
      continue;
    }
    const data = {
      serviceRequestNumber: number,
      description: plan.description.slice(0, 500),
      status: "CLOSED" as const,
      submittedById: submittedBy.id,
      submittedAt: plan.submittedAt,
      closedAt: plan.closedAt,
    };
    if (existing) {
      ticketIdByNumber.set(number, existing.id);
      claimed.add(existing.id);
      if (!options.dryRun) await db.ynhhTicket.update({ where: { id: existing.id }, data });
    } else {
      report.ynhhTickets.createdFromTickets++;
      if (options.dryRun) {
        ticketIdByNumber.set(number, `dry-run:${number}`);
      } else {
        const created = await db.ynhhTicket.create({ data });
        ticketIdByNumber.set(number, created.id);
        claimed.add(created.id);
      }
    }
  }

  // --- YNHH tickets from the tracker table ---------------------------------
  type PlannedEpic = { ticketId: string; personId: string; kind: "NEW" | "MODIFY" | "RENEW" };
  const trackerEpics: PlannedEpic[] = [];

  for (const ticket of tracker.tickets) {
    const submittedBy = personByName(byName, ticket.submitterName);
    if (!submittedBy) {
      report.skipped.push({
        source: "YNHH Ticket Tracker",
        recordId: ticket.sourceRecordIds.join(","),
        reason: `submitter "${ticket.submitterName ?? "(none)"}" does not resolve to a Person`,
      });
      continue;
    }

    // Resolve each grouped row's subject; unresolved names are reported, never guessed.
    const subjects: Array<{ person: PersonRef; kind: "NEW" | "MODIFY" | "RENEW" | null }> = [];
    ticket.briefDescriptions.forEach((text, i) => {
      const name = resolveTrackerPersonName(text, names);
      const person = personByName(byName, name);
      if (!person) {
        report.unresolvedTrackerNames.push({
          recordId: ticket.sourceRecordIds[i] ?? ticket.sourceRecordIds[0],
          text,
        });
        return;
      }
      subjects.push({ person, kind: inferTrackerKind(text) });
    });

    const data = {
      serviceRequestNumber: ticket.serviceRequestNumber,
      airtableRecordId: ticket.airtableRecordId,
      description: ticket.description.slice(0, 500),
      resolution: ticket.notes,
      status: ticket.status,
      submittedById: submittedBy.id,
      submittedAt: ticket.submittedAt,
      closedAt: ticket.closedAt,
    };

    // Prefer a row this import already wrote; then a hub row the tracker
    // duplicates; otherwise create.
    const priorByNumber = ticket.serviceRequestNumber
      ? await db.ynhhTicket.findFirst({ where: { serviceRequestNumber: ticket.serviceRequestNumber } })
      : null;
    const priorById = ticket.airtableRecordId
      ? await db.ynhhTicket.findUnique({ where: { airtableRecordId: ticket.airtableRecordId } })
      : null;
    const mergeTarget =
      priorByNumber ??
      priorById ??
      (subjects.length === 1
        ? findMergeTarget(existingTickets, subjects[0].person.id, ticket.submittedAt, claimed)
        : null);

    let ticketId: string;
    if (mergeTarget) {
      ticketId = mergeTarget.id;
      claimed.add(mergeTarget.id);
      if (!priorByNumber && !priorById) report.ynhhTickets.mergedIntoExisting++;
      if (!options.dryRun) {
        await db.ynhhTicket.update({ where: { id: mergeTarget.id }, data });
      }
    } else {
      report.ynhhTickets.createdFromTracker++;
      if (options.dryRun) {
        ticketId = `dry-run:${ticket.sourceRecordIds[0]}`;
      } else {
        const created = await db.ynhhTicket.create({ data });
        ticketId = created.id;
        claimed.add(created.id);
      }
    }
    if (ticket.serviceRequestNumber) ticketIdByNumber.set(ticket.serviceRequestNumber, ticketId);

    for (const s of subjects) {
      if (s.kind) trackerEpics.push({ ticketId, personId: s.person.id, kind: s.kind });
    }
  }

  // --- Tech requests -------------------------------------------------------
  const attachmentWork: Array<{ requestId: string; row: MappedTechRequest }> = [];

  for (const row of tech.rows) {
    const requester = byAirtableId.get(row.requesterRecordId);
    if (!requester) {
      report.skipped.push({
        source: "Tech Requests",
        recordId: row.airtableRecordId,
        reason: "requester does not resolve to a Person",
      });
      continue;
    }
    const assignee = row.assignedToRecordId ? byAirtableId.get(row.assignedToRecordId) : null;

    const data = {
      number: row.number,
      airtableRecordId: row.airtableRecordId,
      requesterId: requester.id,
      assignedToId: assignee?.id ?? null,
      category: row.category,
      epicSubtype: row.epicSubtype,
      subject: row.subject,
      description: row.description,
      priority: row.priority,
      status: row.status,
      resolution: row.resolution,
      resolvedAt: row.resolvedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      // The Epic intake fields have no TechRequest columns any more; job title
      // and mirror id go onto the EpicRequest below, the rest into its notes.
    };

    const existing = await db.techRequest.findUnique({
      where: { airtableRecordId: row.airtableRecordId },
    });
    let requestId: string;
    if (existing) {
      report.techRequests.updated++;
      requestId = existing.id;
      if (!options.dryRun) await db.techRequest.update({ where: { id: existing.id }, data });
    } else {
      report.techRequests.created++;
      if (options.dryRun) {
        requestId = `dry-run:${row.airtableRecordId}`;
      } else {
        const created = await db.techRequest.create({ data });
        requestId = created.id;
      }
    }

    if (row.attachments.length && !options.skipAttachments) {
      attachmentWork.push({ requestId, row });
    }

    // One Epic request per Epic ticket that names a kind. Keyed on the ticket,
    // so a re-run updates rather than stacking duplicates.
    if (row.epicSubtype) {
      const ticketId = row.serviceRequestNumber
        ? (ticketIdByNumber.get(row.serviceRequestNumber) ?? null)
        : null;
      const epicData = {
        personId: requester.id,
        requestedById: requester.id,
        kind: row.epicSubtype,
        status: (row.status === "CLOSED" ? "COMPLETED" : "SUBMITTED") as "COMPLETED" | "SUBMITTED",
        jobTitle: row.epicJobTitle,
        mirrorEpicId: row.epicMirrorId,
        notes: epicIntakeNote(row),
        completedAt: row.status === "CLOSED" ? row.resolvedAt : null,
        createdAt: row.createdAt,
        techRequestId: requestId,
        ticketId: ticketId && !ticketId.startsWith("dry-run:") ? ticketId : null,
      };
      // Safe to query on a dry run too: requestId is the real id whenever the
      // ticket already exists, so a repeat dry run reports updates, not creates.
      const existingEpic = requestId.startsWith("dry-run:")
        ? null
        : await db.epicRequest.findFirst({ where: { techRequestId: requestId } });
      if (existingEpic) {
        report.epicRequests.updated++;
        if (!options.dryRun) {
          await db.epicRequest.update({ where: { id: existingEpic.id }, data: epicData });
        }
      } else {
        report.epicRequests.created++;
        if (!options.dryRun) await db.epicRequest.create({ data: epicData });
      }
    }
  }

  // --- Epic requests implied by tracker rows -------------------------------
  for (const planned of trackerEpics) {
    if (planned.ticketId.startsWith("dry-run:")) {
      report.epicRequests.created++;
      continue;
    }
    const existing = await db.epicRequest.findFirst({
      where: { ticketId: planned.ticketId, personId: planned.personId, techRequestId: null },
    });
    const epicData = {
      personId: planned.personId,
      requestedById: planned.personId,
      kind: planned.kind,
      status: "COMPLETED" as const,
      ticketId: planned.ticketId,
    };
    if (existing) {
      report.epicRequests.updated++;
      if (!options.dryRun) {
        await db.epicRequest.update({ where: { id: existing.id }, data: epicData });
      }
    } else {
      report.epicRequests.created++;
      if (!options.dryRun) await db.epicRequest.create({ data: epicData });
    }
  }

  // Airtable's Request IDs are written verbatim into the autoincrement column,
  // so the sequence has to be moved past them or the next natively-submitted
  // ticket collides on TechRequest.number.
  const maxNumber = tech.rows.reduce((m, r) => Math.max(m, r.number), 0);
  report.nextTechRequestNumber = maxNumber + 1;

  return { report, attachmentWork };
}
