/**
 * Read-only import of the pre-hub IT Support history from Airtable.
 *
 * Sources (both in the HAVEN Management base):
 *   Tech Requests       -- the IT Support ticket log kept before /support existed.
 *   YNHH Ticket Tracker -- one row per person per YNHH service request.
 *
 * The two sources cover disjoint eras: RITM numbers typed inline on tech
 * requests stop where the tracker table's numbers begin, so they never describe
 * the same YNHH ticket and are imported independently.
 *
 * Nothing here notifies anybody. See load.ts for the two invariants that make
 * that true, and assertNoMessagesQueued below for the check that proves it.
 */
import { prisma } from "@/platform/db";
import { putObject as defaultPutObject } from "@/platform/storage";
import type { AirtableReader } from "../importer";
import { loadSupportHistory, type SupportHistoryReport } from "./load";
import type { MappedTechRequest } from "./transform";

export type SupportHistoryImportOptions = {
  baseId: string;
  techRequestsTableId: string;
  trackerTableId: string;
  dryRun: boolean;
  skipAttachments: boolean;
  fetchImpl?: typeof fetch;
  putObject?: (key: string, bytes: Buffer, contentType: string) => Promise<void>;
};

/**
 * Raised when the import would have queued a message, which it must never do.
 *
 * The message is taken from the path, not hardcoded. This check runs after BOTH
 * paths, but only the dry run has actually rolled anything back: on the apply
 * path the transaction committed before we got here, and attachments were
 * uploaded after it. Claiming a rollback there told an operator mid-cutover that
 * nothing was written when in fact every ticket row and every attachment was,
 * and the natural response to that (re-run the import) is taken on a false
 * premise.
 */
export class SupportHistoryNotificationError extends Error {
  constructor(deltas: string, dryRun: boolean) {
    const disposition = dryRun
      ? `The dry run's transaction was rolled back, so nothing was written.`
      : `THE ROWS ARE ALREADY COMMITTED and any attachments are already uploaded: ` +
        `this check runs after the transaction, not inside it. Do not re-run before ` +
        `inspecting EmailLog, TeamsMessage, and Notification for the rows counted above.`;
    super(
      `The support history import queued outbound messages (${deltas}). It writes through ` +
        `prisma only and must never reach notify() or queueEmail(). ${disposition} ` +
        `Investigate before re-running.`,
    );
    this.name = "SupportHistoryNotificationError";
  }
}

type MessageCounts = { emails: number; teams: number; notifications: number };

async function countQueuedMessages(): Promise<MessageCounts> {
  const [emails, teams, notifications] = await Promise.all([
    prisma.emailLog.count(),
    prisma.teamsMessage.count(),
    prisma.notification.count(),
  ]);
  return { emails, teams, notifications };
}

function describeDeltas(before: MessageCounts, after: MessageCounts): string | null {
  const parts = [
    ["EmailLog", after.emails - before.emails],
    ["TeamsMessage", after.teams - before.teams],
    ["Notification", after.notifications - before.notifications],
  ].filter(([, delta]) => (delta as number) !== 0);
  return parts.length ? parts.map(([name, delta]) => `${name} +${delta}`).join(", ") : null;
}

/**
 * Downloads each Airtable attachment and stores it under the same
 * support/<requestId>/<uuid> convention the app uses, so the existing download
 * route serves imported files with no special-casing. The storage key is
 * derived from the Airtable attachment id, which makes a re-run skip files it
 * already uploaded instead of duplicating them.
 */
async function importAttachments(
  work: Array<{ requestId: string; row: MappedTechRequest }>,
  report: SupportHistoryReport,
  options: SupportHistoryImportOptions,
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const put = options.putObject ?? defaultPutObject;

  for (const { requestId, row } of work) {
    const requester = await prisma.techRequest.findUnique({
      where: { id: requestId },
      select: { requesterId: true },
    });
    if (!requester) continue;

    for (const attachment of row.attachments) {
      const ext = attachment.filename.match(/\.[A-Za-z0-9]{1,8}$/)?.[0] ?? "";
      const key = `support/${requestId}/airtable-${attachment.airtableId}${ext}`;
      const already = await prisma.techRequestAttachment.findFirst({ where: { storageKey: key } });
      if (already) {
        report.attachments.alreadyPresent++;
        continue;
      }
      try {
        const response = await fetchImpl(attachment.url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        await put(key, bytes, attachment.mimeType);
        await prisma.techRequestAttachment.create({
          data: {
            requestId,
            storageKey: key,
            filename: attachment.filename,
            mimeType: attachment.mimeType,
            size: bytes.length,
            uploadedById: requester.requesterId,
          },
        });
        report.attachments.uploaded++;
      } catch (error) {
        // Airtable attachment URLs are short-lived; a failure here loses one
        // file, not the import, so it is reported and the run continues.
        report.attachments.failed++;
        console.warn(
          `  attachment ${attachment.filename} (${attachment.airtableId}) failed: ${String(error)}`,
        );
      }
    }
  }
}

export async function runSupportHistoryImport(
  reader: AirtableReader,
  options: SupportHistoryImportOptions,
): Promise<SupportHistoryReport> {
  const [techRecords, trackerRecords] = await Promise.all([
    reader.listAll(options.baseId, options.techRequestsTableId),
    reader.listAll(options.baseId, options.trackerTableId),
  ]);

  const before = await countQueuedMessages();

  // A dry run must not leave a trace, so it runs inside a transaction that is
  // always rolled back: the planning code then exercises the same queries and
  // constraint checks the real run will, instead of a parallel guess at them.
  let report: SupportHistoryReport;
  let attachmentWork: Array<{ requestId: string; row: MappedTechRequest }> = [];

  if (options.dryRun) {
    class Rollback extends Error {
      constructor(public readonly report: SupportHistoryReport) {
        super("dry run");
      }
    }
    try {
      await prisma.$transaction(
        async (tx) => {
          const result = await loadSupportHistory(
            tx,
            { techRecords, trackerRecords },
            { dryRun: true, skipAttachments: options.skipAttachments },
          );
          throw new Rollback(result.report);
        },
        { timeout: 120_000 },
      );
      throw new Error("unreachable: the dry-run transaction must roll back");
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
      report = error.report;
    }
  } else {
    const result = await prisma.$transaction(
      (tx) =>
        loadSupportHistory(
          tx,
          { techRecords, trackerRecords },
          { dryRun: false, skipAttachments: options.skipAttachments },
        ),
      { timeout: 120_000 },
    );
    report = result.report;
    attachmentWork = result.attachmentWork;

    if (report.nextTechRequestNumber !== null) {
      await prisma.$executeRawUnsafe(
        `SELECT setval(pg_get_serial_sequence('"TechRequest"', 'number'), GREATEST($1::bigint, (SELECT COALESCE(MAX(number), 1) FROM "TechRequest")))`,
        report.nextTechRequestNumber,
      );
    }

    if (!options.skipAttachments) {
      await importAttachments(attachmentWork, report, options);
    }
  }

  const after = await countQueuedMessages();
  const deltas = describeDeltas(before, after);
  if (deltas) throw new SupportHistoryNotificationError(deltas, options.dryRun);

  return report;
}

export type { SupportHistoryReport } from "./load";
