"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/platform/auth/session";
import {
  createTriageChatPreset,
  updateTriageChatPreset,
  deactivateTriageChatPreset,
  TriageChatPresetValidationError,
} from "@/modules/schedule/services/triage-chat-presets";
import type { ActionResult } from "@/platform/ui/run-action";

const PERMISSION = "schedule.manage_triage_chats";

function presetInputFrom(formData: FormData) {
  return {
    name: String(formData.get("name") ?? ""),
    nameTemplate: String(formData.get("nameTemplate") ?? ""),
    messageTemplate: String(formData.get("messageTemplate") ?? ""),
    departmentIds: formData.getAll("departmentIds").map(String),
  };
}

export async function savePresetAction(
  presetId: string | null,
  formData: FormData,
): Promise<ActionResult> {
  const session = await requirePermission(PERMISSION);
  try {
    if (presetId) {
      await updateTriageChatPreset(session.personId, presetId, presetInputFrom(formData));
    } else {
      await createTriageChatPreset(session.personId, presetInputFrom(formData));
    }
  } catch (err) {
    if (err instanceof TriageChatPresetValidationError) return { error: err.message };
    throw err;
  }
  revalidatePath("/schedule/triage-chats");
  return {};
}

export async function deactivatePresetAction(presetId: string): Promise<ActionResult> {
  const session = await requirePermission(PERMISSION);
  await deactivateTriageChatPreset(session.personId, presetId);
  revalidatePath("/schedule/triage-chats");
  return {};
}
