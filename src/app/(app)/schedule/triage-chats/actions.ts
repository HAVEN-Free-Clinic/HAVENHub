"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/platform/auth/session";
import { prisma } from "@/platform/db";
import {
  createTriageChatPreset,
  updateTriageChatPreset,
  deactivateTriageChatPreset,
  TriageChatPresetValidationError,
} from "@/modules/schedule/services/triage-chat-presets";
import {
  createTriageChat,
  retryTriageChatMessage,
  TriageChatConflictError,
  TriageChatNotConnectedError,
} from "@/modules/schedule/services/triage-chat-create";
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

export async function createTriageChatAction(
  presetId: string,
  formData: FormData,
): Promise<ActionResult & { triageChatId?: string }> {
  const session = await requirePermission(PERMISSION);
  try {
    const result = await createTriageChat({
      presetId,
      actorPersonId: session.personId,
      topic: String(formData.get("topic") ?? ""),
      messageBody: String(formData.get("messageBody") ?? ""),
      includePersonIds: formData.getAll("includePersonIds").map(String),
      // The clinic week the review screen was built for. The service re-derives
      // the current week from a fresh now, so this is what lets it refuse a form
      // that was opened before the week rolled over.
      expectedClinicDateKey: String(formData.get("clinicDateKey") ?? ""),
    });
    revalidatePath("/schedule/triage-chats");
    return { triageChatId: result.triageChatId };
  } catch (err) {
    if (err instanceof TriageChatConflictError || err instanceof TriageChatNotConnectedError) {
      return { error: err.message };
    }
    // Graph errors carry the response body, which is the one thing that tells an
    // operator a missing scope from a rejected member. Surface it verbatim.
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export async function retryMessageAction(triageChatId: string): Promise<ActionResult> {
  await requirePermission(PERMISSION);
  const chat = await prisma.triageChat.findUnique({
    where: { id: triageChatId },
    select: { presetId: true },
  });
  if (!chat) return { error: "That chat no longer exists." };
  try {
    // No message body to pass: the row already carries the text exactly as the
    // ED approved it, so a retry re-posts that rather than a re-render of the
    // preset template. This action takes no body, so there is nothing a client
    // could tamper with either.
    await retryTriageChatMessage(triageChatId);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  revalidatePath(`/schedule/triage-chats/${chat.presetId}/created`);
  return {};
}
