import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";

export class TriageChatPresetValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TriageChatPresetValidationError";
  }
}

/**
 * The starting message, matching what the EDs write by hand today. Plain text:
 * the ED edits it as text and it is converted to Teams HTML once, at send.
 */
export const DEFAULT_MESSAGE_TEMPLATE = `Hi everyone! This chat will be used for you all to communicate across departments regarding scheduled patients for the upcoming clinic on {{clinicDate}} and respond to patient calls pertinent to your department. {{sessionCoordinators}} will be the session coordinators.

Please respond to all triages within 24 hours and communicate all information regarding triages here for awareness.

{{rosterBlock}}`;

export type PresetSummary = {
  id: string;
  name: string;
  nameTemplate: string;
  messageTemplate: string;
  order: number;
  departmentIds: string[];
  departmentNames: string[];
};

export type PresetInput = {
  name: string;
  nameTemplate: string;
  messageTemplate: string;
  departmentIds: string[];
  order?: number;
};

function validate(input: PresetInput): PresetInput {
  const name = input.name.trim();
  const nameTemplate = input.nameTemplate.trim();
  const messageTemplate = input.messageTemplate.trim();
  if (!name) throw new TriageChatPresetValidationError("Give the preset a name.");
  if (!nameTemplate) {
    throw new TriageChatPresetValidationError(
      "Give the preset a chat name pattern, e.g. {{clinicDateShort}} Ancillary Triage Chat.",
    );
  }
  if (!messageTemplate) {
    throw new TriageChatPresetValidationError("Give the preset an opening message.");
  }
  return { ...input, name, nameTemplate, messageTemplate };
}

export async function listTriageChatPresets(): Promise<PresetSummary[]> {
  const rows = await prisma.triageChatPreset.findMany({
    where: { isActive: true },
    orderBy: [{ order: "asc" }, { name: "asc" }],
    include: { departments: { include: { department: { select: { id: true, name: true } } } } },
  });
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    nameTemplate: row.nameTemplate,
    messageTemplate: row.messageTemplate,
    order: row.order,
    departmentIds: row.departments.map((d) => d.departmentId),
    departmentNames: row.departments
      .map((d) => d.department.name)
      .sort((a, b) => a.localeCompare(b)),
  }));
}

export type PresetCard = PresetSummary & {
  /** The chat already created for the upcoming clinic date, if there is one. */
  existingChat: { webUrl: string; messagePostedAt: Date | null } | null;
};

/**
 * The index page's data: presets plus whether each already has a chat for the
 * given clinic date.
 *
 * Deliberately NOT loadTriageChatDraft per preset. A draft resolves every member
 * against the Microsoft directory, so building one per card would fire dozens of
 * Graph lookups on every page load to render a button label. The index needs two
 * queries; the lookups belong on the review screen, where their answer is
 * actually shown.
 */
export async function listTriageChatCards(clinicDate: Date | null): Promise<PresetCard[]> {
  const presets = await listTriageChatPresets();
  if (!clinicDate || presets.length === 0) {
    return presets.map((preset) => ({ ...preset, existingChat: null }));
  }
  const chats = await prisma.triageChat.findMany({
    where: { clinicDate, presetId: { in: presets.map((p) => p.id) } },
    select: { presetId: true, webUrl: true, messagePostedAt: true },
  });
  const byPreset = new Map(chats.map((c) => [c.presetId, c]));
  return presets.map((preset) => {
    const chat = byPreset.get(preset.id);
    return {
      ...preset,
      existingChat: chat
        ? { webUrl: chat.webUrl, messagePostedAt: chat.messagePostedAt }
        : null,
    };
  });
}

export async function createTriageChatPreset(
  actorPersonId: string,
  input: PresetInput,
): Promise<{ id: string }> {
  const clean = validate(input);
  const preset = await prisma.triageChatPreset.create({
    data: {
      name: clean.name,
      nameTemplate: clean.nameTemplate,
      messageTemplate: clean.messageTemplate,
      order: clean.order ?? 0,
      departments: {
        create: [...new Set(clean.departmentIds)].map((departmentId) => ({ departmentId })),
      },
    },
    select: { id: true },
  });
  await recordAudit({
    actorPersonId,
    action: "triage_chat_preset.create",
    entityType: "TriageChatPreset",
    entityId: preset.id,
    after: { name: clean.name, departments: clean.departmentIds.length },
  });
  return preset;
}

export async function updateTriageChatPreset(
  actorPersonId: string,
  presetId: string,
  input: PresetInput,
): Promise<void> {
  const clean = validate(input);
  // Replace the department set rather than appending: the form submits the whole
  // selection, so a department the ED unticked must actually go away.
  await prisma.$transaction([
    prisma.triageChatPresetDepartment.deleteMany({ where: { presetId } }),
    prisma.triageChatPreset.update({
      where: { id: presetId },
      data: {
        name: clean.name,
        nameTemplate: clean.nameTemplate,
        messageTemplate: clean.messageTemplate,
        order: clean.order ?? 0,
        departments: {
          create: [...new Set(clean.departmentIds)].map((departmentId) => ({ departmentId })),
        },
      },
    }),
  ]);
  await recordAudit({
    actorPersonId,
    action: "triage_chat_preset.update",
    entityType: "TriageChatPreset",
    entityId: presetId,
    after: { name: clean.name, departments: clean.departmentIds.length },
  });
}

/**
 * Soft delete. A hard delete is blocked by TriageChat's Restrict FK anyway, and
 * a retired preset must still resolve to a name for the chats it created.
 */
export async function deactivateTriageChatPreset(
  actorPersonId: string,
  presetId: string,
): Promise<void> {
  await prisma.triageChatPreset.update({ where: { id: presetId }, data: { isActive: false } });
  await recordAudit({
    actorPersonId,
    action: "triage_chat_preset.deactivate",
    entityType: "TriageChatPreset",
    entityId: presetId,
  });
}
