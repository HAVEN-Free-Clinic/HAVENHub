/**
 * RHD attending roster service.
 *
 * The readiness panel reads each attending's six procedure capabilities. This
 * service lets schedule managers maintain the roster. Mutations require the
 * actor to manage an RHD-family department (same scope as upsertRhdClinic).
 */

import type { RhdAttending } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { manageableScheduleDepartmentIds } from "./builder";
import { serviceLineDepartments } from "@/platform/departments";
import { getActiveTerm } from "@/platform/terms/active-term";
import { isoDateKey } from "../engine/map";

export type CapabilityValue = "yes" | "no" | "unknown";
export const CAPABILITY_KEYS = ["iudIn", "iudOut", "nexplanon", "gac", "emb", "seesMale"] as const;
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

export const CAPABILITY_LABELS: Record<CapabilityKey, string> = {
  iudIn: "IUD In",
  iudOut: "IUD Out",
  nexplanon: "Nexplanon",
  gac: "GAC",
  emb: "EMB",
  seesMale: "Sees Male",
};

export class AttendingForbiddenError extends Error {
  constructor(message = "Actor does not manage any RHD-family department.") {
    super(message);
    this.name = "AttendingForbiddenError";
  }
}

export class AttendingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttendingValidationError";
  }
}

/**
 * Service lines whose attending roster this person may EDIT.
 *
 * A line counts as theirs when they manage the LINE ITSELF (an SRHD director) OR
 * any department inside it (an SCTS director). The second half is deliberate
 * back-compatibility: before rosters were service-line scoped, the check was
 * "manages any RHD-family department", so an SCTS director could maintain the
 * roster. Narrowing to line-managers only would silently revoke that, which is
 * not what generalizing to a second service line is supposed to do.
 *
 * Reading needs none of this: the attending schedule is visible to every member.
 */
export async function manageableServiceLines(
  personId: string,
): Promise<Array<{ id: string; code: string; name: string }>> {
  const [manageable, lines] = await Promise.all([
    manageableScheduleDepartmentIds(personId),
    serviceLineDepartments(),
  ]);
  if (lines.length === 0) return [];
  const mine = new Set(manageable);

  // Departments belonging to each line, so a member-department director still
  // qualifies for their own line and only their own.
  const edges = await prisma.departmentDelegation.findMany({
    where: { managerDepartmentId: { in: lines.map((l) => l.id) } },
    select: { managerDepartmentId: true, managedDepartmentId: true },
  });
  const membersByLine = new Map<string, string[]>();
  for (const e of edges) {
    membersByLine.set(e.managerDepartmentId, [
      ...(membersByLine.get(e.managerDepartmentId) ?? []),
      e.managedDepartmentId,
    ]);
  }

  return lines.filter(
    (l) => mine.has(l.id) || (membersByLine.get(l.id) ?? []).some((id) => mine.has(id)),
  );
}

/**
 * True when the person may edit at least one service line's attending roster.
 * Drives the Attendings nav tab's EDIT affordances; the tab itself is now open
 * to everyone, so this no longer gates visibility.
 */
export async function canManageAnyRhdDept(personId: string): Promise<boolean> {
  return (await manageableServiceLines(personId)).length > 0;
}

/**
 * Asserts the actor may edit `departmentId`'s roster. Scoped per service line,
 * not "manages any": a PCAR director must not be able to edit the reproductive
 * health roster just because they manage some service line.
 */
async function assertServiceLineManager(actor: string, departmentId: string): Promise<void> {
  const lines = await manageableServiceLines(actor);
  if (!lines.some((l) => l.id === departmentId)) throw new AttendingForbiddenError();
}

function validCapability(v: unknown): CapabilityValue {
  if (v === "yes" || v === "no" || v === "unknown") return v;
  throw new AttendingValidationError(`Invalid capability value: ${String(v)}`);
}

export type AttendingScheduleCell = {
  /**
   * Display name, or null when nobody is covering. Deliberately null for a
   * DEACTIVATED attending too: naming someone who no longer covers would read
   * as a filled slot. Use `attendingId` to edit, which keeps the stale value.
   */
  attendingName: string | null;
  /**
   * The raw assignment, whether or not that attending is still active. The
   * editor needs this so saving an unrelated field (a director name, say) does
   * not silently clear an assignment the select could not represent.
   */
  attendingId: string | null;
  directorName: string | null;
  proceduresBooked: number | null;
};

export type AttendingOption = {
  id: string;
  scheduleName: string;
  /** Inactive options are offered only so a stale assignment round-trips. */
  isActive: boolean;
};

/**
 * Why the schedule is empty, when it is.
 *
 * Three unrelated causes used to collapse into one "no clinic dates" message,
 * which sent people to look at the term calendar when the real problem was that
 * no service lines were configured. A clinic with 17 clinic dates was being told
 * it had none.
 */
export type AttendingScheduleEmptyReason = "no-active-term" | "no-clinic-dates" | "no-service-lines";

export type AttendingSchedule = {
  /** Set only when there is nothing to render; null when the grid has rows. */
  emptyReason: AttendingScheduleEmptyReason | null;
  /** The active term, or null when there is none. Needed to write a cell. */
  termId: string | null;
  /** Service lines that have a roster, as table columns. */
  lines: Array<{
    id: string;
    code: string;
    name: string;
    /** Reproductive health books procedures; no other line does. */
    usesProcedures: boolean;
  }>;
  /** Assignable attendings per service line id, active first. */
  optionsByLine: Record<string, AttendingOption[]>;
  /** One row per clinic date in the active term, ascending. */
  dates: Array<{
    dateKey: string;
    clinicDate: Date;
    byLine: Record<string, AttendingScheduleCell>;
  }>;
};

/** Reproductive health keeps the procedure matrix; no other line has one. */
export const PROCEDURE_LINE_CODE = "SRHD";

const EMPTY_CELL: AttendingScheduleCell = {
  attendingName: null,
  attendingId: null,
  directorName: null,
  proceduresBooked: null,
};

/**
 * Who is covering each clinic date in the active term, per service line.
 *
 * Readable by any member: this exists so the volunteers working a shift can see
 * which attending is on it, which was the gap when the roster was manager-only.
 * It exposes only names, never the procedure matrix or notes.
 *
 * A deactivated attending reads as "not set" rather than naming someone who is
 * no longer covering; the row is kept so a manager can see the gap and fill it.
 *
 * Returns empty lists when there is no active term or no clinic dates, which the
 * page renders as an empty state rather than an error.
 */
export async function attendingSchedule(): Promise<AttendingSchedule> {
  const [term, rawLines] = await Promise.all([getActiveTerm(), serviceLineDepartments()]);
  const lines = rawLines.map((l) => ({ ...l, usesProcedures: l.code === PROCEDURE_LINE_CODE }));

  // Ordered most fundamental first, so the reader is told the one thing they
  // have to fix rather than whichever condition happened to be checked last.
  const empty = (emptyReason: AttendingScheduleEmptyReason, termId: string | null) =>
    ({ emptyReason, termId, lines, optionsByLine: {}, dates: [] }) satisfies AttendingSchedule;

  if (!term) return empty("no-active-term", null);
  if (term.clinicDates.length === 0) return empty("no-clinic-dates", term.id);
  if (lines.length === 0) return empty("no-service-lines", term.id);

  const [rows, rosters] = await Promise.all([
    prisma.rhdClinic.findMany({
      where: { termId: term.id },
      select: {
        departmentId: true,
        clinicDate: true,
        directorName: true,
        proceduresBooked: true,
        attendingId: true,
        attending: { select: { fullName: true, isActive: true } },
      },
    }),
    // Inactive attendings are included so an existing assignment to one still
    // has a matching <option>; sorted active-first, and labelled at render.
    prisma.rhdAttending.findMany({
      where: { departmentId: { in: lines.map((l) => l.id) } },
      select: { id: true, scheduleName: true, isActive: true, departmentId: true },
      orderBy: [{ isActive: "desc" }, { scheduleName: "asc" }],
    }),
  ]);

  const optionsByLine: Record<string, AttendingOption[]> = {};
  for (const l of lines) optionsByLine[l.id] = [];
  for (const a of rosters) {
    optionsByLine[a.departmentId]?.push({ id: a.id, scheduleName: a.scheduleName, isActive: a.isActive });
  }

  // Keyed by "<dayKey>|<departmentId>" so a lookup per cell is O(1).
  const byKey = new Map<string, AttendingScheduleCell>();
  for (const r of rows) {
    byKey.set(`${isoDateKey(r.clinicDate)}|${r.departmentId}`, {
      attendingName: r.attending?.isActive ? r.attending.fullName : null,
      attendingId: r.attendingId,
      directorName: r.directorName,
      proceduresBooked: r.proceduresBooked,
    });
  }

  // Term.clinicDates is a raw Postgres array with no ordering guarantee, so sort
  // a copy rather than trusting position (the check-in seed appends out of order).
  const sorted = [...term.clinicDates].sort((a, b) => (isoDateKey(a) < isoDateKey(b) ? -1 : 1));

  return {
    emptyReason: null,
    termId: term.id,
    lines,
    optionsByLine,
    dates: sorted.map((clinicDate) => {
      const dateKey = isoDateKey(clinicDate);
      const byLine: Record<string, AttendingScheduleCell> = {};
      for (const l of lines) {
        byLine[l.id] = byKey.get(`${dateKey}|${l.id}`) ?? EMPTY_CELL;
      }
      return { dateKey, clinicDate, byLine };
    }),
  };
}

/** Every attending, or only one service line's when `departmentId` is given. */
export function listAttendings(departmentId?: string): Promise<RhdAttending[]> {
  return prisma.rhdAttending.findMany({
    where: departmentId ? { departmentId } : undefined,
    orderBy: { scheduleName: "asc" },
  });
}

export function getAttending(id: string): Promise<RhdAttending | null> {
  return prisma.rhdAttending.findUnique({ where: { id } });
}

type CapabilityInput = Partial<Record<CapabilityKey, CapabilityValue | null>>;

/**
 * Copy the capability keys a caller actually supplied onto `into`.
 *
 * A key present with a NULL or empty value means "the form did not render this
 * field", not "clear it". Only the reproductive health line renders the
 * procedure matrix, and both attending pages build their capabilities object by
 * mapping all six keys over FormData, so every other line posts six nulls. Read
 * literally that made `validCapability(null)` throw and no primary care
 * attending could be created or edited at all.
 */
function applyCapabilities(
  into: Record<CapabilityKey, CapabilityValue>,
  from: CapabilityInput | undefined,
): void {
  if (!from) return;
  for (const k of CAPABILITY_KEYS) {
    // Widened to string: these values arrive from FormData, so "" is reachable
    // at runtime even though the declared type does not admit it.
    const v = from[k] as string | null | undefined;
    if (v === undefined || v === null || v === "") continue;
    into[k] = validCapability(v);
  }
}

export async function createAttending(
  actor: string,
  input: {
    scheduleName: string;
    fullName: string;
    /** Managing department whose service line this attending belongs to. */
    departmentId: string;
    capabilities?: CapabilityInput;
    notes?: string | null;
  },
): Promise<RhdAttending> {
  await assertServiceLineManager(actor, input.departmentId);
  const scheduleName = input.scheduleName.trim();
  const fullName = input.fullName.trim();
  if (!scheduleName) throw new AttendingValidationError("Schedule name is required.");
  if (!fullName) throw new AttendingValidationError("Full name is required.");

  const caps: Record<CapabilityKey, CapabilityValue> = {
    iudIn: "unknown", iudOut: "unknown", nexplanon: "unknown", gac: "unknown", emb: "unknown", seesMale: "unknown",
  };
  applyCapabilities(caps, input.capabilities);

  const existing = await prisma.rhdAttending.findUnique({ where: { scheduleName } });
  if (existing) throw new AttendingValidationError(`An attending named "${scheduleName}" already exists.`);

  const created = await prisma.rhdAttending.create({
    data: { scheduleName, fullName, departmentId: input.departmentId, ...caps, notes: input.notes ?? null },
  });
  await recordAudit({
    actorPersonId: actor,
    action: "schedule.attending_create",
    entityType: "RhdAttending",
    entityId: created.id,
    after: { scheduleName, fullName, departmentId: input.departmentId, ...caps, notes: input.notes ?? null, isActive: true },
  });
  return created;
}

export async function updateAttending(
  actor: string,
  id: string,
  patch: { scheduleName?: string; fullName?: string; capabilities?: CapabilityInput; notes?: string | null; isActive?: boolean },
): Promise<RhdAttending> {
  const existing = await prisma.rhdAttending.findUnique({ where: { id } });
  if (!existing) throw new AttendingValidationError("Attending not found.");
  // Scoped to the row's OWN service line, read from the row rather than the
  // request, so managing one line never confers edit rights over another's.
  await assertServiceLineManager(actor, existing.departmentId);

  const data: Record<string, unknown> = {};
  if (patch.scheduleName !== undefined) {
    const sn = patch.scheduleName.trim();
    if (!sn) throw new AttendingValidationError("Schedule name is required.");
    if (sn !== existing.scheduleName) {
      const dup = await prisma.rhdAttending.findUnique({ where: { scheduleName: sn } });
      if (dup) throw new AttendingValidationError(`An attending named "${sn}" already exists.`);
    }
    data.scheduleName = sn;
  }
  if (patch.fullName !== undefined) {
    const fullName = patch.fullName.trim();
    if (!fullName) throw new AttendingValidationError("Full name is required.");
    data.fullName = fullName;
  }
  if (patch.capabilities) {
    // Same null-means-absent rule as createAttending, via a scratch object so
    // only the keys actually supplied reach `data` and the rest stay untouched.
    const caps = {} as Record<CapabilityKey, CapabilityValue>;
    applyCapabilities(caps, patch.capabilities);
    Object.assign(data, caps);
  }
  if ("notes" in patch) data.notes = patch.notes ?? null;
  if (patch.isActive !== undefined) data.isActive = patch.isActive;

  const updated = await prisma.rhdAttending.update({ where: { id }, data });
  const auditShape = (r: typeof existing) => ({
    scheduleName: r.scheduleName,
    fullName: r.fullName,
    iudIn: r.iudIn,
    iudOut: r.iudOut,
    nexplanon: r.nexplanon,
    gac: r.gac,
    emb: r.emb,
    seesMale: r.seesMale,
    notes: r.notes,
    isActive: r.isActive,
  });
  await recordAudit({
    actorPersonId: actor,
    action: "schedule.attending_update",
    entityType: "RhdAttending",
    entityId: id,
    before: auditShape(existing),
    after: auditShape(updated),
  });
  return updated;
}

