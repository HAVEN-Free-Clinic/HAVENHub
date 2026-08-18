/**
 * Assemble everything the review screen needs for one preset: the clinic date,
 * the roster, the rendered chat name and opening message, any warnings, and the
 * chat that already exists for this week if there is one.
 *
 * The member ids are resolved HERE rather than at confirm time so the ED sees
 * who cannot be added before committing, not after.
 */
import { prisma } from "@/platform/db";
import { getSetting } from "@/platform/settings/service";
import { getActiveTerm } from "@/platform/terms/active-term";
import {
  selectCurrentClinicDate,
  formatClinicDate,
  getCurrentClinicChannelLink,
} from "@/platform/teams/channel-link";
import { resolveMemberIds, type ResolvedMember } from "@/platform/teams/member-ids";
import { resolveOpenClinicDate } from "@/platform/attendings/open-clinic-date";
import { formatCalendarDate, isoDateKey } from "@/platform/dates";
import { renderTemplate } from "@/platform/email/render/render";
import { esc } from "@/platform/email/render/escape";
import { resolveTriageRoster, type TriageRoster, type TriageRosterMember } from "./triage-chats";

/**
 * Plain text in, plain text out. The ED edits the message as text, so the
 * template is text too; the HTML conversion happens once, at send.
 */
export function renderTriageText(template: string, context: Record<string, unknown>): string {
  return renderTemplate(template, context, { escape: false });
}

/**
 * Convert the ED's plain-text message to the HTML Teams renders.
 *
 * Escape first, then break lines. Doing it in the other order would escape the
 * <br> tags this function just inserted.
 */
export function textToTeamsHtml(text: string): string {
  return esc(text).replace(/\r?\n/g, "<br>");
}

export type TriageChatDraft = {
  preset: { id: string; name: string; nameTemplate: string; messageTemplate: string };
  term: { id: string; name: string };
  clinicDate: Date;
  clinicDateKey: string;
  topic: string;
  messageBody: string;
  roster: TriageRoster;
  resolved: ResolvedMember<TriageRosterMember>[];
  warnings: string[];
  existingChat: { id: string; graphChatId: string; webUrl: string; messagePostedAt: Date | null } | null;
};

export type DraftDeps = {
  now?: Date;
  resolveIds?: typeof resolveMemberIds;
};

/** Read the leadership department codes, tolerating whitespace around commas. */
async function alwaysIncludeCodes(): Promise<string[]> {
  const raw = await getSetting<string>("triageChats.alwaysIncludeDepartmentCodes");
  return raw
    .split(",")
    .map((code) => code.trim().toUpperCase())
    .filter(Boolean);
}

export async function loadTriageChatDraft(
  presetId: string,
  deps: DraftDeps = {},
): Promise<TriageChatDraft | null> {
  const { now = new Date(), resolveIds = resolveMemberIds } = deps;

  const preset = await prisma.triageChatPreset.findUnique({
    where: { id: presetId },
    include: { departments: { include: { department: true } } },
  });
  if (!preset) return null;

  const term = await getActiveTerm();
  if (!term) return null;

  // Same selector the clinic channel link and the shift reminders use, so all
  // three always agree on which Saturday "this week" means.
  const clinicDate = selectCurrentClinicDate(term.clinicDates, now);
  if (!clinicDate) return null;
  const clinicDateKey = isoDateKey(clinicDate);

  const warnings: string[] = [];

  // A closed Saturday stays in Term.clinicDates as a flagged ClinicDay rather
  // than being removed, so the selector above happily picks one. A WARNING and
  // not a block, by spec: the ED is the person who would know the clinic is
  // running after all, and this feature is not the place to overrule them.
  // resolveOpenClinicDate returns null for "not a clinic day at all" too, which
  // cannot happen here because clinicDate came out of term.clinicDates.
  if (!(await resolveOpenClinicDate(term, clinicDateKey))) {
    warnings.push(
      "This clinic date is marked closed in the attending schedule. Create the chat only if the clinic is actually running.",
    );
  }

  const codes = await alwaysIncludeCodes();
  const alwaysDepartments = await prisma.department.findMany({
    where: { code: { in: codes } },
    select: { id: true, code: true, name: true },
  });
  const missingCodes = codes.filter((code) => !alwaysDepartments.some((d) => d.code === code));
  if (missingCodes.length > 0) {
    warnings.push(
      `The leadership department setting names ${missingCodes.join(", ")}, which matches no department. Fix it in Admin > Settings.`,
    );
  }

  const selectedDepartments = preset.departments.map((d) => ({
    id: d.department.id,
    code: d.department.code,
    name: d.department.name,
  }));

  const departmentIds = [
    ...new Set([...selectedDepartments, ...alwaysDepartments].map((d) => d.id)),
  ];

  // Load the term's assignments, then filter to the clinic date by UTC day key.
  // Never compare a clinic date by raw timestamp.
  const rows = await prisma.shiftAssignment.findMany({
    where: { termId: term.id, departmentId: { in: departmentIds } },
    select: {
      personId: true,
      departmentId: true,
      clinicDate: true,
      role: true,
      triage: true,
      department: { select: { id: true, code: true, name: true } },
      person: {
        select: { id: true, name: true, netId: true, contactEmail: true, entraObjectId: true },
      },
    },
  });
  const dated = rows.filter((r) => isoDateKey(r.clinicDate) === clinicDateKey);

  // Only people STILL active in the department they are assigned to. Offboarding
  // removes the membership but leaves future assignments until a director clears
  // them, so without this an offboarded volunteer joins a twenty-person chat.
  const activeMemberships = await prisma.termMembership.findMany({
    where: {
      termId: term.id,
      status: "ACTIVE",
      personId: { in: [...new Set(dated.map((r) => r.personId))] },
    },
    select: { personId: true, departmentId: true },
  });
  const activeInDept = new Set(activeMemberships.map((m) => `${m.personId}:${m.departmentId}`));

  const roster = resolveTriageRoster({
    assignments: dated
      .filter((r) => activeInDept.has(`${r.personId}:${r.departmentId}`))
      .map((r) => ({
        personId: r.personId,
        role: r.role,
        triage: r.triage,
        department: r.department,
        person: r.person,
      })),
    selectedDepartments,
    alwaysIncludeDepartments: alwaysDepartments,
  });

  for (const name of roster.emptyDepartments) {
    warnings.push(`${name} has no triage director on shift for this clinic date.`);
  }
  // An always-include department contributing nobody is quieter and worse than a
  // selected one contributing nobody: its template variable
  // ({{sessionCoordinators}}, {{clinicalAdvisors}}) renders as an empty string
  // into whatever sentence the preset wraps around it, so the message reads
  // "... will be the session coordinators" with nobody named and nothing said.
  for (const name of roster.emptyAlwaysIncludeDepartments) {
    warnings.push(
      `${name} joins every triage chat but has nobody on shift for this clinic date, so the opening message will not name anyone from it.`,
    );
  }
  if (roster.members.length === 0) {
    warnings.push("Nobody is on shift for this clinic date, so there is nobody to add.");
  }

  // Never throws and degrades to null, so a Graph blip costs the link and not
  // the draft.
  const channelLink = await getCurrentClinicChannelLink({ now });

  const context = {
    clinicDate: formatCalendarDate(clinicDate, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    }),
    clinicDateShort: formatClinicDate(clinicDate).replace(/-/g, "."),
    sessionCoordinators: roster.sessionCoordinators.join(", "),
    clinicalAdvisors: roster.clinicalAdvisors.join(", "),
    rosterBlock: roster.rosterBlock,
    teamsChannelUrl: channelLink?.webUrl ?? "",
  };

  const resolved = resolveIds(roster.members);
  const unresolved = resolved.filter((r) => r.source === "unresolved");
  if (unresolved.length > 0) {
    warnings.push(
      `${unresolved.length} ${unresolved.length === 1 ? "person" : "people"} cannot be added automatically and must be added by hand in Teams.`,
    );
  }

  const existingChat = await prisma.triageChat.findUnique({
    where: { presetId_clinicDate: { presetId: preset.id, clinicDate } },
    select: { id: true, graphChatId: true, webUrl: true, messagePostedAt: true },
  });

  return {
    preset: {
      id: preset.id,
      name: preset.name,
      nameTemplate: preset.nameTemplate,
      messageTemplate: preset.messageTemplate,
    },
    term: { id: term.id, name: term.name },
    clinicDate,
    clinicDateKey,
    topic: renderTriageText(preset.nameTemplate, context),
    messageBody: renderTriageText(preset.messageTemplate, context),
    roster,
    resolved,
    warnings,
    existingChat,
  };
}

export type { TriageRosterMember };
