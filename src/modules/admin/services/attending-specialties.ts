/**
 * Attending specialties service: list, create, update, delete.
 *
 * AttendingSpecialty is the clinic's list of clinical specialties (Primary Care,
 * Reproductive Health, Dermatology...). It used to exist only in prisma/seed.ts,
 * so adding a rotating specialty clinic (the "Steroid Clinic" ops asked for) took
 * a code change and a deploy. This service is the admin-editable version of that
 * list.
 *
 * Mirrors departments.ts: typed errors, actor-scoped mutations that audit. Unlike
 * departments.ts, the permission check lives HERE as well as at the page/action
 * boundary. The permission is schedule.manage_attendings (the one already guarding
 * the attending roster in modules/schedule/services/attendings.ts), and the rows
 * this service writes are read by the schedule grid, so the door is checked twice:
 * once by the route and once by the code that actually writes.
 *
 * There is deliberately NO soft delete here. Department and Subcommittee both
 * carry isActive because historical rows point at them and must always resolve to
 * a name; AttendingSpecialty has no such column in the schema, and adding one is
 * out of scope. Deletion is therefore hard, and refused outright while anything
 * still references the row (see deleteAttendingSpecialty).
 */
import type { AttendingSpecialty } from "@prisma/client";
import { prisma, isUniqueConstraintError } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { can } from "@/platform/rbac/engine";

/** Matches the seeded codes (PC, RHD, NEPHRO) and the department code rule. */
const CODE_RE = /^[A-Z0-9]{2,12}$/;

/** The permission maintaining the attending roster, reused verbatim. */
export const MANAGE_PERMISSION = "schedule.manage_attendings";

export class AttendingSpecialtyForbiddenError extends Error {
  constructor(message = "You do not manage attending specialties.") {
    super(message);
    this.name = "AttendingSpecialtyForbiddenError";
  }
}

export class AttendingSpecialtyNotFoundError extends Error {
  constructor(public id: string) {
    super(`Attending specialty ${id} not found.`);
    this.name = "AttendingSpecialtyNotFoundError";
  }
}

export class AttendingSpecialtyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttendingSpecialtyValidationError";
  }
}

/** Both `code` and `name` are @unique; `field` says which one collided. */
export class AttendingSpecialtyConflictError extends Error {
  constructor(
    public field: "code" | "name",
    public value: string
  ) {
    super(
      field === "code"
        ? `A specialty with code "${value}" already exists.`
        : `A specialty named "${value}" already exists.`
    );
    this.name = "AttendingSpecialtyConflictError";
  }
}

/** Raised instead of deleting a specialty something still points at. */
export class AttendingSpecialtyInUseError extends Error {
  constructor(
    public counts: ReferenceCounts,
    message: string
  ) {
    super(message);
    this.name = "AttendingSpecialtyInUseError";
  }
}

/** How many rows in each of the three referencing tables point at a specialty. */
export type ReferenceCounts = {
  attendings: number;
  capabilities: number;
  clinicDays: number;
};

export type AttendingSpecialtyRow = AttendingSpecialty & {
  _count: ReferenceCounts;
};

/** Throws unless the actor holds schedule.manage_attendings. */
async function assertCanManage(actorPersonId: string): Promise<void> {
  if (!(await can(actorPersonId, MANAGE_PERMISSION))) {
    throw new AttendingSpecialtyForbiddenError();
  }
}

/**
 * Every specialty in display order, with the counts the list page shows.
 *
 * Ordered by `order` then `code`: `order` is a hand-set Int with no uniqueness
 * guarantee, so two specialties sharing one value would otherwise render in an
 * arbitrary, run-to-run-unstable sequence.
 *
 * Read-only, so it takes no actor: reference data is visible to anyone who can
 * already open the page, and the page carries the gate.
 */
export function listAttendingSpecialties(): Promise<AttendingSpecialtyRow[]> {
  return prisma.attendingSpecialty.findMany({
    include: { _count: { select: { attendings: true, capabilities: true, clinicDays: true } } },
    orderBy: [{ order: "asc" }, { code: "asc" }],
  });
}

export function getAttendingSpecialty(id: string): Promise<AttendingSpecialty | null> {
  return prisma.attendingSpecialty.findUnique({ where: { id } });
}

/** Reference counts for one specialty, across all three pointing tables. */
export async function referenceCounts(id: string): Promise<ReferenceCounts> {
  const [attendings, capabilities, clinicDays] = await Promise.all([
    prisma.attending.count({ where: { specialtyId: id } }),
    prisma.attendingCapability.count({ where: { specialtyId: id } }),
    prisma.clinicDay.count({ where: { specialtyId: id } }),
  ]);
  return { attendings, capabilities, clinicDays };
}

/**
 * Turn a Prisma P2002 into the typed conflict error.
 *
 * `meta.target` on Postgres is the list of columns in the violated index, so it
 * says which of the two unique columns collided. It is typed as unknown and has
 * been an array, a string, and absent across Prisma versions, so read it
 * defensively and fall back to the field we can still name from the input.
 */
function conflictFromPrisma(err: unknown, code: string, name: string): AttendingSpecialtyConflictError {
  const target = (err as { meta?: { target?: unknown } }).meta?.target;
  const columns = Array.isArray(target) ? target.map(String) : typeof target === "string" ? [target] : [];
  if (columns.includes("name")) return new AttendingSpecialtyConflictError("name", name);
  return new AttendingSpecialtyConflictError("code", code);
}

/** Trim + validate the writable fields shared by create and update. */
function normalize(input: { code: string; name: string; order: number }): {
  code: string;
  name: string;
  order: number;
} {
  const code = input.code.trim().toUpperCase();
  if (!CODE_RE.test(code)) {
    throw new AttendingSpecialtyValidationError(
      "Code must be 2-12 uppercase letters or digits (e.g. DERM)."
    );
  }
  const name = input.name.trim();
  if (!name) throw new AttendingSpecialtyValidationError("Name is required.");
  // Number("abc") is NaN, which nullish coalescing in the form layer does not
  // catch, so reject it here rather than letting Prisma 500 on the insert.
  if (!Number.isInteger(input.order)) {
    throw new AttendingSpecialtyValidationError("Display order must be a whole number.");
  }
  return { code, name, order: input.order };
}

/** Refuse a code or name already taken by ANOTHER row, case-insensitively.
 *  The database indexes are case-SENSITIVE, so this catches "derm" against
 *  "DERM" before the insert; the P2002 catch below still guards the race. */
async function assertNoClash(code: string, name: string, exceptId?: string): Promise<void> {
  const clashes = await prisma.attendingSpecialty.findMany({
    where: {
      ...(exceptId ? { id: { not: exceptId } } : {}),
      OR: [
        { code: { equals: code, mode: "insensitive" } },
        { name: { equals: name, mode: "insensitive" } },
      ],
    },
    select: { code: true, name: true },
  });
  for (const row of clashes) {
    if (row.code.toLowerCase() === code.toLowerCase()) {
      throw new AttendingSpecialtyConflictError("code", code);
    }
  }
  if (clashes.length > 0) throw new AttendingSpecialtyConflictError("name", name);
}

export async function createAttendingSpecialty(
  actorPersonId: string,
  input: { code: string; name: string; runsSpecialtyClinic?: boolean; order?: number }
): Promise<AttendingSpecialty> {
  await assertCanManage(actorPersonId);
  const { code, name, order } = normalize({
    code: input.code,
    name: input.name,
    order: input.order ?? 0,
  });
  const runsSpecialtyClinic = input.runsSpecialtyClinic ?? false;

  await assertNoClash(code, name);

  let specialty: AttendingSpecialty;
  try {
    specialty = await prisma.attendingSpecialty.create({
      data: { code, name, runsSpecialtyClinic, order },
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) throw conflictFromPrisma(err, code, name);
    throw err;
  }

  await recordAudit({
    actorPersonId,
    action: "attending_specialty.create",
    entityType: "AttendingSpecialty",
    entityId: specialty.id,
    after: {
      code: specialty.code,
      name: specialty.name,
      runsSpecialtyClinic: specialty.runsSpecialtyClinic,
      order: specialty.order,
    },
  });
  return specialty;
}

/**
 * Update the writable fields. `code` is FROZEN after creation, like a
 * department's.
 *
 * This function once accepted a new code, on the reasoning that a specialty code
 * is only a display abbreviation resolved by row id everywhere. That is not
 * true: platform/attendings/import/roster.ts matches the roster spreadsheet's
 * free text to a specialty through a hardcoded alias table keyed on these exact
 * codes (PC, RHD, BHD, DERM, NEURO, NEPHRO). Renaming one there silently stops
 * the importer recognising that specialty, and an attending it can no longer
 * place is reported as unrecognised rather than filed. A rename is therefore a
 * code change, not a data edit, and freezing it here is the honest answer.
 *
 * `name` and `order` stay editable; neither is keyed on anywhere.
 */
export async function updateAttendingSpecialty(
  actorPersonId: string,
  id: string,
  input: { name: string; runsSpecialtyClinic: boolean; order?: number }
): Promise<AttendingSpecialty> {
  await assertCanManage(actorPersonId);
  const before = await prisma.attendingSpecialty.findUnique({ where: { id } });
  if (!before) throw new AttendingSpecialtyNotFoundError(id);

  const { code, name, order } = normalize({
    code: before.code,
    name: input.name,
    order: input.order ?? before.order,
  });

  await assertNoClash(code, name, id);

  // Un-ticking "runs specialty clinic" on a specialty a clinic day already names
  // destroys that day's assignment, just more quietly than deleting the row.
  // The day's Specialty Clinic select is built from the specialties that run one
  // (attending-day-view.tsx), so the stored id stops matching any option, the
  // control falls back to "None", and the next save of that day for ANY reason
  // posts an empty specialty and clears it. There is no way back through the
  // builder either, since upsertClinicDay refuses a specialty that does not run
  // a clinic. Refuse for the same reason delete refuses.
  if (before.runsSpecialtyClinic && !input.runsSpecialtyClinic) {
    const clinicDays = await prisma.clinicDay.count({ where: { specialtyId: id } });
    if (clinicDays > 0) {
      throw new AttendingSpecialtyInUseError(
        { attendings: 0, capabilities: 0, clinicDays },
        `"${before.name}" is the specialty clinic on ${plural(clinicDays, "clinic day", "clinic days")}. ` +
          "Clear it from those days first, then turn this off."
      );
    }
  }

  let specialty: AttendingSpecialty;
  try {
    specialty = await prisma.attendingSpecialty.update({
      where: { id },
      data: { code, name, runsSpecialtyClinic: input.runsSpecialtyClinic, order },
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) throw conflictFromPrisma(err, code, name);
    throw err;
  }

  await recordAudit({
    actorPersonId,
    action: "attending_specialty.update",
    entityType: "AttendingSpecialty",
    entityId: id,
    before: {
      code: before.code,
      name: before.name,
      runsSpecialtyClinic: before.runsSpecialtyClinic,
      order: before.order,
    },
    after: {
      code: specialty.code,
      name: specialty.name,
      runsSpecialtyClinic: specialty.runsSpecialtyClinic,
      order: specialty.order,
    },
  });
  return specialty;
}

/** English list: "3 attendings", "3 attendings and 1 clinic day", "a, b and c". */
function joinPhrases(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Hard-delete a specialty, but ONLY when nothing points at it.
 *
 * All three foreign keys (Attending.specialtyId, AttendingCapability.specialtyId,
 * ClinicDay.specialtyId) are onDelete: SetNull, so the database would accept this
 * delete happily and silently rewrite history: attendings would lose the specialty
 * they work in, a clinic date would forget which specialty clinic ran that day,
 * and (worst of the three) a capability question scoped to one specialty would
 * become an unscoped question asked of the ENTIRE roster. None of that is
 * recoverable from the row we just removed, so refuse rather than cascade, and
 * name what is still holding on so the admin knows where to go.
 */
export async function deleteAttendingSpecialty(actorPersonId: string, id: string): Promise<void> {
  await assertCanManage(actorPersonId);
  const before = await prisma.attendingSpecialty.findUnique({ where: { id } });
  if (!before) throw new AttendingSpecialtyNotFoundError(id);

  // Atomic claim, NOT count-then-delete.
  //
  // All three relations are onDelete: SetNull (schema.prisma), so the database
  // will not refuse this delete: it will quietly null the references instead.
  // That makes the check the only protection, and a separate count followed by a
  // separate delete leaves a window where a clinic day assigned in between is
  // silently unassigned. The `none` conditions are evaluated by the DELETE
  // itself, so the row goes only if it is genuinely unreferenced at that instant.
  //
  // Same shape as the conditional updateMany claims used across this codebase.
  const deleted = await prisma.attendingSpecialty.deleteMany({
    where: {
      id,
      attendings: { none: {} },
      capabilities: { none: {} },
      clinicDays: { none: {} },
    },
  });

  if (deleted.count === 0) {
    // Re-read to say WHAT is holding it, rather than reporting the counts from
    // before the attempt. Reaching here with all-zero counts means it was deleted
    // by someone else in the meantime, which is the same outcome the caller
    // wanted, so treat it as done.
    const counts = await referenceCounts(id);
    const parts: string[] = [];
    if (counts.attendings > 0) parts.push(plural(counts.attendings, "attending", "attendings"));
    if (counts.capabilities > 0) {
      parts.push(plural(counts.capabilities, "capability question", "capability questions"));
    }
    if (counts.clinicDays > 0) parts.push(plural(counts.clinicDays, "clinic day", "clinic days"));
    if (parts.length === 0) return;

    throw new AttendingSpecialtyInUseError(
      counts,
      `"${before.name}" is still used by ${joinPhrases(parts)}. ` +
        "Reassign or clear those first, then delete it."
    );
  }

  await recordAudit({
    actorPersonId,
    action: "attending_specialty.delete",
    entityType: "AttendingSpecialty",
    entityId: id,
    before: {
      code: before.code,
      name: before.name,
      runsSpecialtyClinic: before.runsSpecialtyClinic,
      order: before.order,
    },
  });
}
