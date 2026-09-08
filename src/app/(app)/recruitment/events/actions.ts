"use server";
import { redirect } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import { RecruitmentAuthError } from "@/modules/recruitment/services/review";
import type { AttendanceEventKind } from "@prisma/client";
import {
  AttendanceEventError,
  createEvent,
  deleteEvent,
  linkAttendee,
  removeEventCheckIn,
  updateEvent,
} from "@/modules/recruitment/services/attendance-events";
import { getActiveTerm } from "@/platform/terms/active-term";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import { parseZonedInput } from "@/platform/dates";
import { prisma } from "@/platform/db";

/** Both flash params follow the app-wide convention (see ui/toast/flash.ts), so
 *  a redirect carrying either pops a toast without the page rendering anything:
 *  `error` is claimed by name, `saved` by the registry. The training roster's
 *  older `?msg=`/`?err=` pair is claimed by neither and renders nothing. */
function bounce(path: string, params: { saved?: boolean; error?: string }): string {
  const q = new URLSearchParams();
  if (params.saved) q.set("saved", "1");
  if (params.error) q.set("error", params.error);
  const query = q.toString();
  return query ? `${path}?${query}` : path;
}

/** Turn the two expected service errors into a flash; rethrow anything else. */
function flashOrThrow(err: unknown, path: string): never {
  if (err instanceof RecruitmentAuthError || err instanceof AttendanceEventError) {
    redirect(bounce(path, { error: (err as Error).message }));
  }
  throw err;
}

/**
 * Read a datetime-local field as a wall clock in the DISPLAY zone.
 *
 * Not `new Date(value)`: that reads "2026-09-03T18:00" in the SERVER's zone,
 * which is UTC in production -- so a staffer entering 6:00 PM for an event in
 * New Haven would have stored 6:00 PM UTC, and the event, its emails and its
 * kiosk would all have said 2:00 PM. parseZonedInput is the same helper the
 * cycle application window and interview scheduling already use.
 */
async function parseDateTime(raw: FormDataEntryValue | null): Promise<Date | null> {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value.length === 0) return null;
  return parseZonedInput(value, await getDisplayTimeZone());
}

function text(form: FormData, key: string): string | null {
  const value = form.get(key);
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
}

export async function createEventAction(form: FormData) {
  const person = await requirePersonSession();
  const path = "/recruitment/events";
  const cycleId = text(form, "cycleId");
  const kind = (text(form, "kind") ?? "OTHER") as AttendanceEventKind;
  const startsAt = await parseDateTime(form.get("startsAt"));

  if (!startsAt) redirect(bounce(path, { error: "Give the event a valid start date and time." }));

  // A cycle-less event still needs a term to hang off. The active term is the
  // only defensible default: attendance is asked about within a term, and an
  // event created today belongs to the term running today.
  let termId = cycleId ? null : (await getActiveTerm())?.id ?? null;
  if (cycleId) {
    const cycle = await prisma.recruitmentCycle.findUnique({
      where: { id: cycleId },
      select: { termId: true },
    });
    termId = cycle?.termId ?? null;
  }
  if (!termId) {
    redirect(
      bounce(path, {
        error: "There is no active term, so pick a recruitment cycle for this event.",
      }),
    );
  }

  let eventId: string;
  try {
    const event = await createEvent(
      {
        termId,
        cycleId,
        kind,
        title: (text(form, "title") ?? "") as string,
        startsAt,
        endsAt: await parseDateTime(form.get("endsAt")),
        location: text(form, "location"),
        notes: text(form, "notes"),
      },
      person.personId,
    );
    eventId = event.id;
  } catch (err) {
    flashOrThrow(err, path);
  }
  // Straight to the new event: whoever just created it is about to take
  // attendance at it, not admire it in a list.
  redirect(bounce(`/recruitment/events/${eventId}`, { saved: true }));
}

export async function updateEventAction(eventId: string, form: FormData) {
  const person = await requirePersonSession();
  const path = `/recruitment/events/${eventId}`;
  const startsAt = await parseDateTime(form.get("startsAt"));
  if (!startsAt) redirect(bounce(path, { error: "Give the event a valid start date and time." }));

  try {
    await updateEvent(
      eventId,
      {
        title: (text(form, "title") ?? "") as string,
        startsAt,
        endsAt: await parseDateTime(form.get("endsAt")),
        location: text(form, "location"),
        notes: text(form, "notes"),
      },
      person.personId,
    );
  } catch (err) {
    flashOrThrow(err, path);
  }
  redirect(bounce(path, { saved: true }));
}

export async function deleteEventAction(eventId: string) {
  const person = await requirePersonSession();
  try {
    await deleteEvent(eventId, person.personId);
  } catch (err) {
    flashOrThrow(err, `/recruitment/events/${eventId}`);
  }
  redirect(bounce("/recruitment/events", { saved: true }));
}

export async function removeCheckInAction(eventId: string, attendanceId: string) {
  const person = await requirePersonSession();
  const path = `/recruitment/events/${eventId}`;
  try {
    await removeEventCheckIn(attendanceId, person.personId);
  } catch (err) {
    flashOrThrow(err, path);
  }
  redirect(bounce(path, { saved: true }));
}

export async function linkAttendeeAction(eventId: string, attendanceId: string, form: FormData) {
  const person = await requirePersonSession();
  const path = `/recruitment/events/${eventId}`;
  const personId = text(form, "personId");
  if (!personId) redirect(bounce(path, { error: "Pick the person to link this attendance to." }));
  try {
    await linkAttendee(attendanceId, personId, person.personId);
  } catch (err) {
    flashOrThrow(err, path);
  }
  redirect(bounce(path, { saved: true }));
}

// checkInAction lives with the door screen itself, at src/app/check-in/actions.ts.
// The screen is a top-level route rather than one in this group (see that
// route's layout for why), and the action belongs beside the only page that
// calls it.
