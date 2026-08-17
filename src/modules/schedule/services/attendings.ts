/**
 * Attending roster and the clinic-wide attending schedule.
 *
 * ONE roster and ONE schedule for the whole clinic, maintained by Faculty
 * Relations (schedule.manage_attendings). Attendings are faculty: they hold no
 * TermMembership, belong to no department, and cover whichever slot the schedule
 * puts them in, so nothing here is department-scoped.
 *
 * The schedule is a grid: one row per clinic date, one column per ClinicSlot
 * ("9am-12pm", "RHD Attending", "BHD Clinic"...). A slot may carry more than one
 * attending. Each date also carries the week's on-call attending, the rotating
 * specialty clinic, and the reproductive-health director and procedure count.
 */

import type { Attending } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { can } from "@/platform/rbac/engine";
import { getActiveTerm } from "@/platform/terms/active-term";
import { isoDateKey } from "../engine/map";

// The department -> attending mapping lives in platform: the weekly reminder
// email needs it too, and platform may not import from modules. Re-exported so
// schedule-side callers still reach it through this service.
export {
  departmentSlotIds,
  departmentAttendingsForDates,
  type DepartmentAttending,
} from "@/platform/attendings/coverage";

export type CapabilityValue = "yes" | "no" | "unknown";

/** One question asked about attendings, and who it is asked of. */
export type Capability = {
  id: string;
  key: string;
  label: string;
  /** Null when every attending is asked. */
  specialtyId: string | null;
};

/** A clinical specialty, as the roster and schedule render it. */
export type SpecialtyView = {
  id: string;
  code: string;
  name: string;
  runsSpecialtyClinic: boolean;
};

/** A column of the schedule grid. */
export type ClinicSlotView = {
  id: string;
  label: string;
  startTime: string;
  endTime: string;
  allowsMultiple: boolean;
  /** The department this column's attending covers; null for a shared column. */
  departmentId: string | null;
  department: { code: string; name: string } | null;
};

/** An attending plus the answers on file, for the roster table and edit form. */
export type AttendingWithCapabilities = Attending & {
  /** Capability id -> answer. A MISSING id means "unknown", never a gap. */
  capabilityValues: Record<string, CapabilityValue>;
};

export class AttendingForbiddenError extends Error {
  constructor(message = "You do not manage the attending roster.") {
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
 * Whether this person may maintain attendings.
 *
 * A single unscoped permission, not a directorship. Attendings belong to no
 * department, so there is nothing for a department-scoped grant to scope TO;
 * the previous rule (directors of a "service line") was the wrong shape and let
 * every clinical team's director rewrite the roster.
 */
export async function canManageAttendings(personId: string): Promise<boolean> {
  return can(personId, "schedule.manage_attendings");
}

/** Throws unless the actor may maintain attendings. */
async function assertCanManage(actor: string): Promise<void> {
  if (!(await canManageAttendings(actor))) throw new AttendingForbiddenError();
}

/**
 * Whether this person may READ the whole clinic's attending coverage.
 *
 * Wider than {@link canManageAttendings} on purpose. Faculty Relations builds the
 * schedule, but the people running the clinic day -- anyone holding the
 * clinic-wide schedule.edit_all -- need to see who is covering every column
 * without being able to change it. The two are ORed rather than the viewer
 * requiring both, so neither group is locked out of a read-only page.
 */
export async function canViewAttendingCoverage(personId: string): Promise<boolean> {
  const [editsAll, managesAttendings] = await Promise.all([
    can(personId, "schedule.edit_all"),
    can(personId, "schedule.manage_attendings"),
  ]);
  return editsAll || managesAttendings;
}

/** Validate an answer a CALLER supplied. Throws, because bad input is a bug. */
function validCapability(v: unknown): CapabilityValue {
  if (v === "yes" || v === "no" || v === "unknown") return v;
  throw new AttendingValidationError(`Invalid capability value: ${String(v)}`);
}

/**
 * Read an answer already in the database.
 *
 * Degrades to "unknown" rather than throwing. Every writer goes through
 * validCapability, but this is a READ path behind the roster table, and a single
 * bad row should not 500 a page the whole clinic uses.
 */
function storedCapability(v: string): CapabilityValue {
  return v === "yes" || v === "no" ? v : "unknown";
}

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

export function listSpecialties(): Promise<SpecialtyView[]> {
  return prisma.attendingSpecialty.findMany({
    select: { id: true, code: true, name: true, runsSpecialtyClinic: true },
    orderBy: { order: "asc" },
  });
}

export function listClinicSlots(): Promise<ClinicSlotView[]> {
  return prisma.clinicSlot.findMany({
    select: {
      id: true,
      label: true,
      startTime: true,
      endTime: true,
      allowsMultiple: true,
      departmentId: true,
      department: { select: { code: true, name: true } },
    },
    orderBy: { order: "asc" },
  });
}

export function listCapabilities(): Promise<Capability[]> {
  return prisma.attendingCapability.findMany({
    select: { id: true, key: true, label: true, specialtyId: true },
    orderBy: { order: "asc" },
  });
}

/**
 * The questions asked of an attending in `specialtyId`.
 *
 * Unscoped capabilities (specialtyId null) are asked of everyone; scoped ones
 * only of that specialty. An attending with no specialty is asked only the
 * unscoped ones, which is the honest answer rather than every question at once.
 */
export async function capabilitiesForSpecialty(specialtyId: string | null): Promise<Capability[]> {
  const all = await listCapabilities();
  return all.filter((c) => c.specialtyId === null || c.specialtyId === specialtyId);
}

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

/**
 * The roster, with each attending's answers.
 *
 * Answers come along because the roster table renders a column per capability;
 * fetching them separately would be an N+1 across 47 rows.
 */
export async function listAttendings(opts: { activeOnly?: boolean } = {}): Promise<AttendingWithCapabilities[]> {
  const rows = await prisma.attending.findMany({
    where: opts.activeOnly ? { isActive: true } : undefined,
    include: { capabilities: { select: { capabilityId: true, value: true } } },
    orderBy: [{ isActive: "desc" }, { scheduleName: "asc" }],
  });

  return rows.map(({ capabilities, ...attending }) => ({
    ...attending,
    capabilityValues: Object.fromEntries(
      capabilities.map((v) => [v.capabilityId, storedCapability(v.value)]),
    ),
  }));
}

/** One attending with their answers, keyed by capability id. */
export async function getAttending(id: string): Promise<AttendingWithCapabilities | null> {
  const row = await prisma.attending.findUnique({
    where: { id },
    include: { capabilities: { select: { capabilityId: true, value: true } } },
  });
  if (!row) return null;

  const { capabilities, ...attending } = row;
  return {
    ...attending,
    capabilityValues: Object.fromEntries(
      capabilities.map((v) => [v.capabilityId, storedCapability(v.value)]),
    ),
  };
}

/** Answers posted from a form, keyed by capability ID. */
export type CapabilityInput = Record<string, CapabilityValue | null | undefined>;

/** Field-name prefix for a capability answer, shared by the form and the parser. */
const CAPABILITY_FIELD_PREFIX = "capability:";

/**
 * Read capability answers out of a submitted form.
 *
 * Takes whatever `capability:<id>` fields are present rather than iterating a
 * fixed key list, so an attending whose specialty asks nothing simply posts
 * none, and that is a no-op rather than an error.
 */
export function capabilitiesFromFormData(formData: FormData): CapabilityInput {
  const out: CapabilityInput = {};
  for (const [name, value] of formData.entries()) {
    if (!name.startsWith(CAPABILITY_FIELD_PREFIX)) continue;
    out[name.slice(CAPABILITY_FIELD_PREFIX.length)] = String(value) as CapabilityValue;
  }
  return out;
}

/**
 * Turn posted answers into value rows for an attending in `specialtyId`.
 *
 * Three rules, each load-bearing:
 *   - an id not asked of this specialty is dropped, so a crafted post cannot
 *     attach a reproductive-health qualification to a dermatologist;
 *   - a missing, null, or empty answer means "the form did not render this
 *     field", not "clear it";
 *   - "unknown" stores no row, matching the absence-is-unknown rule, so the two
 *     representations can never disagree.
 */
async function resolveCapabilityRows(
  specialtyId: string | null,
  from: CapabilityInput | undefined,
): Promise<Array<{ capabilityId: string; value: CapabilityValue }>> {
  if (!from) return [];
  const asked = new Set((await capabilitiesForSpecialty(specialtyId)).map((c) => c.id));

  const rows: Array<{ capabilityId: string; value: CapabilityValue }> = [];
  for (const [capabilityId, raw] of Object.entries(from)) {
    if (!asked.has(capabilityId)) continue;
    // Widened to string: values arrive from FormData, so "" is reachable.
    const v = raw as string | null | undefined;
    if (v === undefined || v === null || v === "") continue;
    const value = validCapability(v);
    if (value === "unknown") continue;
    rows.push({ capabilityId, value });
  }
  return rows;
}

/** Capability answers as key -> value, for the audit trail. */
async function auditCapabilities(attendingId: string): Promise<Record<string, string>> {
  const rows = await prisma.attendingCapabilityValue.findMany({
    where: { attendingId },
    select: { value: true, capability: { select: { key: true } } },
  });
  return Object.fromEntries(rows.map((r) => [r.capability.key, r.value]));
}

export type AttendingInput = {
  scheduleName: string;
  fullName: string;
  credentials?: string | null;
  specialtyId?: string | null;
  email?: string | null;
  phone?: string | null;
  notes?: string | null;
  capabilities?: CapabilityInput;
};

function cleanAttendingInput(input: AttendingInput) {
  const scheduleName = input.scheduleName.trim();
  const fullName = input.fullName.trim();
  if (!scheduleName) throw new AttendingValidationError("Schedule name is required.");
  if (!fullName) throw new AttendingValidationError("Full name is required.");
  return {
    scheduleName,
    fullName,
    credentials: input.credentials?.trim() || null,
    specialtyId: input.specialtyId || null,
    email: input.email?.trim() || null,
    phone: input.phone?.trim() || null,
    notes: input.notes?.trim() || null,
  };
}

export async function createAttending(actor: string, input: AttendingInput): Promise<Attending> {
  await assertCanManage(actor);
  const data = cleanAttendingInput(input);

  const existing = await prisma.attending.findUnique({ where: { scheduleName: data.scheduleName } });
  if (existing) {
    throw new AttendingValidationError(`An attending named "${data.scheduleName}" already exists.`);
  }
  const capabilityRows = await resolveCapabilityRows(data.specialtyId, input.capabilities);

  const created = await prisma.attending.create({
    data: { ...data, capabilities: { create: capabilityRows } },
  });
  await recordAudit({
    actorPersonId: actor,
    action: "schedule.attending_create",
    entityType: "Attending",
    entityId: created.id,
    after: { ...data, isActive: true, capabilities: await auditCapabilities(created.id) },
  });
  return created;
}

export async function updateAttending(
  actor: string,
  id: string,
  patch: Partial<AttendingInput> & { isActive?: boolean },
): Promise<Attending> {
  await assertCanManage(actor);
  const existing = await prisma.attending.findUnique({ where: { id } });
  if (!existing) throw new AttendingValidationError("Attending not found.");

  const data: Record<string, unknown> = {};
  if (patch.scheduleName !== undefined) {
    const sn = patch.scheduleName.trim();
    if (!sn) throw new AttendingValidationError("Schedule name is required.");
    if (sn !== existing.scheduleName) {
      const dup = await prisma.attending.findUnique({ where: { scheduleName: sn } });
      if (dup) throw new AttendingValidationError(`An attending named "${sn}" already exists.`);
    }
    data.scheduleName = sn;
  }
  if (patch.fullName !== undefined) {
    const fullName = patch.fullName.trim();
    if (!fullName) throw new AttendingValidationError("Full name is required.");
    data.fullName = fullName;
  }
  if ("credentials" in patch) data.credentials = patch.credentials?.trim() || null;
  if ("specialtyId" in patch) data.specialtyId = patch.specialtyId || null;
  if ("email" in patch) data.email = patch.email?.trim() || null;
  if ("phone" in patch) data.phone = patch.phone?.trim() || null;
  if ("notes" in patch) data.notes = patch.notes?.trim() || null;
  if (patch.isActive !== undefined) data.isActive = patch.isActive;

  // Answers are validated against the specialty the attending will HAVE after
  // this save, not the one they had before: changing specialty and answers in
  // one edit must not validate the new answers against the old questions.
  const specialtyId = "specialtyId" in patch ? patch.specialtyId ?? null : existing.specialtyId;
  const capabilityRows = patch.capabilities
    ? await resolveCapabilityRows(specialtyId, patch.capabilities)
    : null;

  const before = { ...auditShape(existing), capabilities: await auditCapabilities(id) };

  const updated = await prisma.$transaction(async (tx) => {
    // Replace-set, not merge: the form posts every question its specialty asks,
    // so an answer moved back to "unknown" must delete its row.
    if (capabilityRows) {
      await tx.attendingCapabilityValue.deleteMany({ where: { attendingId: id } });
      if (capabilityRows.length > 0) {
        await tx.attendingCapabilityValue.createMany({
          data: capabilityRows.map((r) => ({ ...r, attendingId: id })),
        });
      }
    }
    return tx.attending.update({ where: { id }, data });
  });

  await recordAudit({
    actorPersonId: actor,
    action: "schedule.attending_update",
    entityType: "Attending",
    entityId: id,
    before,
    after: { ...auditShape(updated), capabilities: await auditCapabilities(id) },
  });
  return updated;
}

function auditShape(r: Attending) {
  return {
    scheduleName: r.scheduleName,
    fullName: r.fullName,
    credentials: r.credentials,
    specialtyId: r.specialtyId,
    email: r.email,
    phone: r.phone,
    notes: r.notes,
    isActive: r.isActive,
  };
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

/** Who is covering one slot on one date, in slot-internal order. */
export type SlotCoverage = {
  slotId: string;
  attendings: Array<{ id: string; scheduleName: string; isActive: boolean }>;
};

/** One date of the schedule. */
export type AttendingScheduleRow = {
  dateKey: string;
  clinicDate: Date;
  /**
   * Whether the term calendar lists this date as a clinic date.
   *
   * False for a Saturday the term skips. Such a date still gets a row -- the
   * builder spans the whole term so a gap is visible rather than absent -- but
   * it is closed no matter what ClinicDay says.
   */
  isClinicDate: boolean;
  /**
   * Closed to clinical staffing. DERIVED: a date the term does not list is
   * closed regardless of the stored flag, so removing a date from the term
   * calendar closes it everywhere at once rather than leaving a staffed row
   * behind that only a manual edit could correct.
   */
  isClosed: boolean;
  /**
   * The stored ClinicDay.isClosed, for the editor's own checkbox. Kept apart
   * from `isClosed` so a non-clinic date does not silently report the manager's
   * setting back as "checked" and then persist that on the next save.
   */
  storedClosed: boolean;
  closedNote: string | null;
  onCallAttendingId: string | null;
  onCallName: string | null;
  specialtyId: string | null;
  /**
   * Legacy reproductive health fields, still carried on the row but no longer
   * edited from this page. Who is directing is read off the schedule's DIRECTOR
   * assignments (see BuilderRhd.directors), and procedures booked is edited in
   * the builder's RHD readiness panel, beside the cap warning it drives. Both
   * remain here because the Airtable import writes them for historical dates.
   */
  directorName: string | null;
  proceduresBooked: number | null;
  /** One entry per slot the clinic defines, in column order, even when empty. */
  slots: SlotCoverage[];
};

/**
 * Why the schedule is empty, when it is.
 *
 * Three unrelated causes used to collapse into one "no clinic dates" message,
 * which sent people to the term calendar when the real problem was elsewhere.
 */
export type AttendingScheduleEmptyReason = "no-active-term" | "no-clinic-dates" | "no-slots";

export type AttendingSchedule = {
  emptyReason: AttendingScheduleEmptyReason | null;
  termId: string | null;
  termName: string | null;
  /** False for an ARCHIVED term, which is readable but not writable. */
  editable: boolean;
  slots: ClinicSlotView[];
  specialties: SpecialtyView[];
  /** Assignable attendings, active first; inactive kept so a stale row shows. */
  options: Array<{ id: string; scheduleName: string; isActive: boolean }>;
  rows: AttendingScheduleRow[];
};

/**
 * Every Saturday from `start` to `end` inclusive, anchored at noon UTC.
 *
 * Noon rather than midnight so the date renders as the same Saturday in any US
 * time zone, matching how Term.clinicDates are stored.
 */
function saturdaysBetween(start: Date, end: Date): Date[] {
  const out: Date[] = [];
  // Rebuild from the UTC calendar parts: a term's start/end carry whatever time
  // they were saved with, and only the calendar day matters here.
  const at = (d: Date) =>
    new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12));

  const last = at(end);
  const cursor = at(start);
  // 6 = Saturday. Step forward to the first one, then a week at a time.
  cursor.setUTCDate(cursor.getUTCDate() + ((6 - cursor.getUTCDay() + 7) % 7));
  for (let d = cursor; d <= last; d = new Date(d.getTime() + 7 * 86400000)) {
    out.push(new Date(d));
  }
  return out;
}

/**
 * The dates the attending builder spans: every Saturday of the term, UNION the
 * term's own clinic dates.
 *
 * The union matters in both directions. Saturdays the term skips are included so
 * a break in the calendar is visible (and can still carry an on-call attending)
 * rather than silently absent; and a clinic date that is NOT a Saturday -- a
 * make-up day, a weekday special clinic -- is never dropped just because it
 * falls off the weekly rhythm.
 */
function builderDates(term: { startDate: Date; endDate: Date; clinicDates: Date[] }): Date[] {
  const byKey = new Map<string, Date>();
  for (const d of saturdaysBetween(term.startDate, term.endDate)) byKey.set(isoDateKey(d), d);
  for (const d of term.clinicDates) byKey.set(isoDateKey(d), d);
  return [...byKey.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, d]) => d);
}

/**
 * The clinic-wide attending schedule for one term.
 *
 * One row per date the builder spans (see {@link builderDates}), one entry per
 * slot. Readable by anyone who can see the schedule module; editing is gated
 * separately on schedule.manage_attendings.
 *
 * `termId` selects the working term; omitted, the active one is used.
 */
export async function attendingSchedule(termId?: string): Promise<AttendingSchedule> {
  const [term, slots, specialties] = await Promise.all([
    termId
      ? prisma.term.findUnique({
          where: { id: termId },
          select: { id: true, name: true, status: true, startDate: true, endDate: true, clinicDates: true },
        })
      : getActiveTerm(),
    listClinicSlots(),
    listSpecialties(),
  ]);

  // Ordered most fundamental first, so the reader is told the one thing they
  // have to fix rather than whichever condition happened to be checked last.
  const empty = (
    emptyReason: AttendingScheduleEmptyReason,
    t: { id: string; name: string } | null,
  ) =>
    ({
      emptyReason,
      termId: t?.id ?? null,
      termName: t?.name ?? null,
      editable: false,
      slots,
      specialties,
      options: [],
      rows: [],
    }) satisfies AttendingSchedule;

  if (!term) return empty("no-active-term", null);
  if (term.clinicDates.length === 0) return empty("no-clinic-dates", term);
  if (slots.length === 0) return empty("no-slots", term);

  const [days, roster] = await Promise.all([
    prisma.clinicDay.findMany({
      where: { termId: term.id },
      select: {
        clinicDate: true,
        isClosed: true,
        closedNote: true,
        onCallAttendingId: true,
        onCallAttending: { select: { scheduleName: true, isActive: true } },
        specialtyId: true,
        directorName: true,
        proceduresBooked: true,
        attendings: {
          orderBy: { order: "asc" },
          select: {
            slotId: true,
            attendingId: true,
            attending: { select: { scheduleName: true, isActive: true } },
          },
        },
      },
    }),
    // Inactive attendings are included so an existing assignment to one still
    // has a matching <option>; sorted active-first, and labelled at render.
    prisma.attending.findMany({
      select: { id: true, scheduleName: true, isActive: true },
      orderBy: [{ isActive: "desc" }, { scheduleName: "asc" }],
    }),
  ]);

  const byDate = new Map(days.map((d) => [isoDateKey(d.clinicDate), d]));
  const clinicDateKeys = new Set(term.clinicDates.map(isoDateKey));

  return {
    emptyReason: null,
    termId: term.id,
    termName: term.name,
    editable: term.status !== "ARCHIVED",
    slots,
    specialties,
    options: roster,
    rows: builderDates(term).map((clinicDate) => {
      const dateKey = isoDateKey(clinicDate);
      const day = byDate.get(dateKey);
      const isClinicDate = clinicDateKeys.has(dateKey);
      const storedClosed = day?.isClosed ?? false;
      const assigned = new Map<string, SlotCoverage["attendings"]>();
      for (const a of day?.attendings ?? []) {
        assigned.set(a.slotId, [
          ...(assigned.get(a.slotId) ?? []),
          { id: a.attendingId, scheduleName: a.attending.scheduleName, isActive: a.attending.isActive },
        ]);
      }
      return {
        dateKey,
        clinicDate,
        isClinicDate,
        isClosed: !isClinicDate || storedClosed,
        storedClosed,
        closedNote: day?.closedNote ?? null,
        onCallAttendingId: day?.onCallAttendingId ?? null,
        // A deactivated on-call reads as unset, the same rule the slots use.
        onCallName: day?.onCallAttending?.isActive ? day.onCallAttending.scheduleName : null,
        specialtyId: day?.specialtyId ?? null,
        directorName: day?.directorName ?? null,
        proceduresBooked: day?.proceduresBooked ?? null,
        // Driven by the clinic's SLOTS, not the stored rows, so a column added
        // after a date was scheduled still renders as an empty cell to fill.
        slots: slots.map((s) => ({ slotId: s.id, attendings: assigned.get(s.id) ?? [] })),
      };
    }),
  };
}

/** Everyone covering one clinic date, grouped by slot, for readers. */
export type DayCoverage = Array<{
  slotLabel: string;
  startTime: string;
  endTime: string;
  attendings: string[];
}>;

/**
 * Who is covering `clinicDate`, for the people working it.
 *
 * Deactivated attendings are omitted: naming someone who no longer covers would
 * read as a staffed slot. Empty slots are dropped entirely, so a reader sees
 * only what is actually staffed.
 */
export async function coverageForDate(termId: string, clinicDate: Date): Promise<DayCoverage> {
  const day = await prisma.clinicDay.findUnique({
    where: { termId_clinicDate: { termId, clinicDate } },
    select: {
      isClosed: true,
      attendings: {
        orderBy: [{ slot: { order: "asc" } }, { order: "asc" }],
        select: {
          slot: { select: { label: true, startTime: true, endTime: true } },
          attending: { select: { scheduleName: true, isActive: true } },
        },
      },
    },
  });
  if (!day || day.isClosed) return [];

  const bySlot = new Map<string, DayCoverage[number]>();
  for (const a of day.attendings) {
    if (!a.attending.isActive) continue;
    const entry = bySlot.get(a.slot.label) ?? {
      slotLabel: a.slot.label,
      startTime: a.slot.startTime,
      endTime: a.slot.endTime,
      attendings: [],
    };
    entry.attendings.push(a.attending.scheduleName);
    bySlot.set(a.slot.label, entry);
  }
  return [...bySlot.values()];
}
