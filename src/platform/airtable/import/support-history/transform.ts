/**
 * Pure Airtable-record to hub-shape mapping for the support history import.
 * No database access and no network: everything here is a total function of the
 * records handed to it, so the mapping decisions are unit-testable in isolation
 * and the load step (load.ts) only has to worry about identity and writes.
 */
import type {
  EpicRequestKind,
  TechRequestCategory,
  TechRequestPriority,
  TechRequestStatus,
  YnhhTicketStatus,
} from "@prisma/client";
import { TECH_REQUEST_FIELDS as T, YNHH_TRACKER_FIELDS as Y } from "../../fields";

type Record_ = { id: string; fields: Record<string, unknown>; createdTime?: string };

/** Airtable returns single/multi selects as objects; every other cell is a scalar. */
const selectName = (v: unknown): string | null => {
  if (v && typeof v === "object" && "name" in v) {
    const name = (v as { name?: unknown }).name;
    return typeof name === "string" ? name : null;
  }
  return typeof v === "string" ? v : null;
};

const selectNames = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(selectName).filter((n): n is string => Boolean(n)) : [];

const str = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed.length ? trimmed : null;
};

const date = (v: unknown): Date | null => {
  const raw = str(v);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const linkIds = (v: unknown): string[] =>
  Array.isArray(v)
    ? v
        .map((entry) =>
          typeof entry === "string" ? entry : ((entry as { id?: unknown })?.id ?? null),
        )
        .filter((id): id is string => typeof id === "string")
    : [];

const CATEGORY_BY_REQUEST_TYPE: Record<string, TechRequestCategory> = {
  "Epic Issue": "EPIC",
  "DUO Multi-Factor Authentication": "DUO_MFA",
  "General IT Issue": "GENERAL_IT",
  "Teams Access": "TEAMS",
  Other: "OTHER",
};

const KIND_BY_EPIC_ISSUE_TYPE: Record<string, EpicRequestKind> = {
  Renewal: "RENEW",
  Modification: "MODIFY",
  "New Account": "NEW",
};

const PRIORITY_BY_NAME: Record<string, TechRequestPriority> = {
  Low: "LOW",
  Medium: "MEDIUM",
  High: "HIGH",
  Critical: "CRITICAL",
};

/**
 * Airtable status to hub status.
 *
 * The three terminal Airtable states all land as CLOSED: this is archived
 * history, and CLOSED keeps it out of the working queues and out of reach of
 * the reopen/attach paths that expect a live ticket. "Sent Activation
 * Instructions" and "Sent Renewal Instructions" are meaningfully different from
 * a plain "Resolved", so the original wording is preserved verbatim in the
 * resolution text rather than being flattened away.
 */
const STATUS_BY_NAME: Record<string, TechRequestStatus> = {
  Resolved: "CLOSED",
  "Sent Activation Instructions": "CLOSED",
  "Sent Renewal Instructions": "CLOSED",
  "Unable to Reach": "CLOSED",
  Submitted: "SUBMITTED",
  "In Progress": "IN_PROGRESS",
  "Awaiting Your Action": "AWAITING_REQUESTER",
  "Request Sent to YNHH": "AWAITING_YNHH",
  "YNHH Assigned Ticket": "AWAITING_YNHH",
};

const SUBJECT_MAX = 80;

/**
 * Airtable has no subject column, but TechRequest requires one and the hub's
 * ticket list is scanned by subject. The first line of the description is far
 * more useful there than a uniform category label would be (45 of the 121
 * source rows are Epic new-account requests), so that is preferred.
 *
 * `fallback` covers the handful of rows with no description at all. The caller
 * builds it from Airtable's own select wording rather than the hub's label
 * constants, both because platform code must not import module code and
 * because the source wording is the more faithful record of what was filed.
 */
export function synthesizeSubject(description: string | null, fallback: string): string {
  const firstLine = str(description)?.split("\n")[0]?.trim();
  if (firstLine) {
    if (firstLine.length <= SUBJECT_MAX) return firstLine;
    const cut = firstLine.slice(0, SUBJECT_MAX - 3);
    const lastSpace = cut.lastIndexOf(" ");
    return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trimEnd()}...`;
  }
  return fallback;
}

/**
 * Normalises a Service Request cell to a comparable key. The source contains
 * leading spaces, one trailing period, and bare "RITM"/"INC" placeholders that
 * carry no ticket number; those must not collapse unrelated rows into one
 * ticket, so they resolve to null and the caller keys on the record id instead.
 */
export function serviceRequestKey(value: unknown): string | null {
  const raw = str(value);
  if (!raw) return null;
  const cleaned = raw.replace(/\.+$/, "").trim().toUpperCase();
  return /^(RITM|INC)\d+$/.test(cleaned) ? cleaned : null;
}

/** Request-kind and Epic-context words that trail a person's name in tracker rows. */
const TRACKER_NOISE =
  /\b(renew(al|s)?|new(\s+account)?|modif(y|ication|ies)?|mod|epic|pats|pham|orhi|attdn|individual|bulk)\b/gi;

/**
 * Tracker rows name their subject in free text ("Iris Becene Renew"). Resolves
 * one only when it is unambiguous: an exact name match wins outright, and a
 * containment match counts only when exactly one roster name contains it.
 * Anything else returns null and is reported for a human to link by hand,
 * because a wrong link here silently attributes an Epic account to the wrong
 * person.
 */
export function resolveTrackerPersonName(
  briefDescription: string,
  rosterNames: string[],
): string | null {
  const cleaned = briefDescription
    .replace(/[()]/g, " ")
    .replace(TRACKER_NOISE, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length < 4) return null;
  const lower = cleaned.toLowerCase();

  const exact = rosterNames.filter((n) => n.toLowerCase() === lower);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;

  const contains = rosterNames.filter((n) => n.toLowerCase().includes(lower));
  return contains.length === 1 ? contains[0] : null;
}

/**
 * Infers the Epic request kind from a tracker row's free text ("Iris Becene
 * Renew"). Modification is tested before New because a row can read "PHAM New
 * Account Modify"; returns null when the text names no kind, so the caller can
 * record the ticket without inventing an Epic request for it.
 */
export function inferTrackerKind(
  briefDescription: string,
): Exclude<EpicRequestKind, "DEACTIVATE"> | null {
  if (/\bmodif(y|ication|ies)?\b|\bmod\b/i.test(briefDescription)) return "MODIFY";
  if (/\brenew(al|s)?\b/i.test(briefDescription)) return "RENEW";
  if (/\bnew\b/i.test(briefDescription)) return "NEW";
  return null;
}

export type MappedAttachment = {
  airtableId: string;
  url: string;
  filename: string;
  size: number;
  mimeType: string;
};

export type MappedTechRequest = {
  airtableRecordId: string;
  /** Airtable's autoNumber, reused as TechRequest.number. */
  number: number;
  requesterRecordId: string;
  assignedToRecordId: string | null;
  category: TechRequestCategory;
  epicSubtype: EpicRequestKind | null;
  subject: string;
  description: string;
  priority: TechRequestPriority;
  status: TechRequestStatus;
  resolution: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /** Inline RITM typed on the ticket, before the tracker table existed. */
  serviceRequestNumber: string | null;
  /** Lands on EpicRequest.jobTitle; TechRequest has no column for it. */
  epicJobTitle: string | null;
  /** Lands on EpicRequest.mirrorEpicId. */
  epicMirrorId: string | null;
  /**
   * Access window and YNHHS employment, rendered into EpicRequest.notes. These
   * had TechRequest columns once, removed as dead in "remove seven dead
   * TechRequest intake columns"; the values are still worth keeping as context
   * on the Epic request, so they go into free text rather than resurrecting a
   * column the app does not read.
   */
  epicStartDate: Date | null;
  epicEndDate: Date | null;
  worksAtYnhh: boolean | null;
  attachments: MappedAttachment[];
};

/**
 * Renders the Epic intake context that no longer has its own columns into a
 * short note. Returns null when Airtable recorded none of it, so the import
 * never writes an empty "Epic intake" heading.
 */
export function epicIntakeNote(row: {
  epicStartDate: Date | null;
  epicEndDate: Date | null;
  worksAtYnhh: boolean | null;
}): string | null {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const parts: string[] = [];
  if (row.epicStartDate) parts.push(`Access from ${iso(row.epicStartDate)}`);
  if (row.epicEndDate) parts.push(`Access until ${iso(row.epicEndDate)}`);
  if (row.worksAtYnhh !== null) {
    parts.push(row.worksAtYnhh ? "Works at YNHHS" : "Does not work at YNHHS");
  }
  return parts.length ? `Imported from Airtable. ${parts.join(". ")}.` : null;
}

export type TechRequestTransform = {
  rows: MappedTechRequest[];
  skipped: Array<{ recordId: string; reason: string }>;
};

export function transformTechRequests(records: Record_[]): TechRequestTransform {
  const rows: MappedTechRequest[] = [];
  const skipped: TechRequestTransform["skipped"] = [];

  for (const record of records) {
    const f = record.fields;
    const requesterRecordId = linkIds(f[T.requester])[0] ?? null;
    if (!requesterRecordId) {
      skipped.push({ recordId: record.id, reason: "no requester link" });
      continue;
    }
    const number = f[T.requestId];
    if (typeof number !== "number") {
      skipped.push({ recordId: record.id, reason: "no Request ID" });
      continue;
    }

    const requestTypeName = selectName(f[T.requestType]);
    const epicIssueTypeName = selectName(f[T.epicIssueType]);
    const category = CATEGORY_BY_REQUEST_TYPE[requestTypeName ?? ""] ?? "OTHER";
    const epicSubtype = KIND_BY_EPIC_ISSUE_TYPE[epicIssueTypeName ?? ""] ?? null;
    const airtableStatus = selectName(f[T.status]);
    const status = STATUS_BY_NAME[airtableStatus ?? ""] ?? "CLOSED";

    const body = str(f[T.description]);
    const modification = str(f[T.modificationDescription]);
    const description =
      [body, modification && `Requested modification: ${modification}`]
        .filter(Boolean)
        .join("\n\n") || "(no description recorded in Airtable)";

    // Four different Airtable statuses collapse into CLOSED, and the difference
    // between them is real ("Sent Renewal Instructions" is not the same outcome
    // as "Resolved"), so the original wording is kept alongside the resolution.
    // Open tickets get no such line: the hub status already says the same thing,
    // and a resolution on an unresolved ticket reads as though it were finished.
    const resolutionDetails = str(f[T.resolutionDetails]);
    const provenance =
      status === "CLOSED" && airtableStatus ? `Airtable status: ${airtableStatus}` : null;
    const resolution = [resolutionDetails, provenance].filter(Boolean).join("\n\n") || null;

    const worksAtYnhhAnswer = selectName(f[T.worksAtYnhh]);

    rows.push({
      airtableRecordId: record.id,
      number,
      requesterRecordId,
      assignedToRecordId: linkIds(f[T.assignedTo])[0] ?? null,
      category,
      epicSubtype,
      subject: synthesizeSubject(
        body,
        [requestTypeName ?? "IT request", epicIssueTypeName].filter(Boolean).join(": "),
      ),
      description,
      priority: PRIORITY_BY_NAME[selectName(f[T.priority]) ?? ""] ?? "MEDIUM",
      status,
      resolution,
      resolvedAt: date(f[T.dateResolved]),
      createdAt: date(f[T.dateSubmitted]) ?? date(record.createdTime) ?? new Date(),
      updatedAt: date(f[T.lastModified]) ?? date(record.createdTime) ?? new Date(),
      serviceRequestNumber: serviceRequestKey(f[T.ynhhTicketNumber]),
      epicJobTitle: selectName(f[T.jobTitle]),
      epicMirrorId: str(f[T.epicIdToMirror]),
      epicStartDate: date(f[T.startDate]),
      epicEndDate: date(f[T.endDate]),
      worksAtYnhh: worksAtYnhhAnswer === null ? null : worksAtYnhhAnswer === "Yes",
      // T.governmentId and T.netId are read by nobody on purpose. The government
      // ID (an NPI for providers) is sensitive and its column was deliberately
      // dropped, so the import does not reintroduce it as free text; the NetID
      // is already authoritative on Person.
      attachments: Array.isArray(f[T.attachments])
        ? (f[T.attachments] as Array<Record<string, unknown>>).flatMap((a) => {
            const url = str(a.url);
            const filename = str(a.filename);
            const airtableId = str(a.id);
            if (!url || !filename || !airtableId) return [];
            return [
              {
                airtableId,
                url,
                filename,
                size: typeof a.size === "number" ? a.size : 0,
                mimeType: str(a.type) ?? "application/octet-stream",
              },
            ];
          })
        : [],
    });
  }

  return { rows, skipped };
}

export type MappedTrackerTicket = {
  /** Set only for single-row tickets with no usable Service Request number. */
  airtableRecordId: string | null;
  serviceRequestNumber: string | null;
  sourceRecordIds: string[];
  description: string;
  notes: string | null;
  status: YnhhTicketStatus;
  submitterName: string | null;
  submittedAt: Date;
  closedAt: Date | null;
  /** Raw "Brief Description" per grouped row, for person resolution in load.ts. */
  briefDescriptions: string[];
};

export function transformTrackerTickets(records: Record_[]): {
  tickets: MappedTrackerTicket[];
} {
  // Rows sharing a Service Request number are one real YNHH ticket covering
  // several people; a placeholder number cannot group, so those stay 1:1.
  const groups = new Map<string, Record_[]>();
  for (const record of records) {
    const key = serviceRequestKey(record.fields[Y.serviceRequestNumber]);
    const groupKey = key ?? `record:${record.id}`;
    const existing = groups.get(groupKey);
    if (existing) existing.push(record);
    else groups.set(groupKey, [record]);
  }

  const tickets: MappedTrackerTicket[] = [];
  for (const [groupKey, group] of groups) {
    const grouped = groupKey.startsWith("record:") ? null : groupKey;
    const briefDescriptions = group
      .map((r) => str(r.fields[Y.briefDescription])?.replace(/\s+/g, " ").trim())
      .filter((d): d is string => Boolean(d));
    const notes = group
      .map((r) => str(r.fields[Y.ticketNotes]))
      .filter((n): n is string => Boolean(n));
    const submittedDates = group
      .map((r) => date(r.fields[Y.dateSubmitted]) ?? date(r.createdTime))
      .filter((d): d is Date => Boolean(d));
    const closedDates = group
      .map((r) => date(r.fields[Y.dateClosed]))
      .filter((d): d is Date => Boolean(d));

    // A grouped ticket is only closed once every row covered by it is closed.
    const allClosed = group.every((r) => selectNames(r.fields[Y.ticketStatus]).includes("Closed"));

    tickets.push({
      airtableRecordId: grouped ? null : group[0].id,
      serviceRequestNumber: grouped,
      sourceRecordIds: group.map((r) => r.id),
      description: briefDescriptions.join("; "),
      notes: notes.length ? notes.join("\n\n") : null,
      status: allClosed ? "CLOSED" : "OPEN",
      submitterName: selectName(group[0].fields[Y.submitter]),
      submittedAt: submittedDates.sort((a, b) => +a - +b)[0] ?? new Date(),
      closedAt: allClosed ? (closedDates.sort((a, b) => +b - +a)[0] ?? null) : null,
      briefDescriptions,
    });
  }

  return { tickets };
}
