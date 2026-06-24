"use server";

import { requirePersonSession } from "@/platform/auth/session";
import { markRead, markAllRead } from "./inbox";

/** Mark one of the signed-in person's notifications read. */
export async function markReadAction(id: string): Promise<void> {
  const { personId } = await requirePersonSession();
  await markRead(personId, id);
}

/** Mark all of the signed-in person's notifications read. */
export async function markAllReadAction(): Promise<void> {
  const { personId } = await requirePersonSession();
  await markAllRead(personId);
}
