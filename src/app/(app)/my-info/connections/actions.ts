"use server";

import { revalidatePath } from "next/cache";
import { requireModuleAccess } from "@/platform/auth/session";
import { can } from "@/platform/rbac/engine";
import { connectionOwner } from "@/platform/oauth/connections";
import { revokeConnection } from "@/platform/oauth/tokens";

/**
 * Disconnect an app. The owner may revoke their own connection; an
 * admin.access holder may revoke anyone's (the switch for a lost laptop or a
 * departing staff member). Top-level with a hidden id, like every other form
 * action whose id must survive this file being edited.
 */
export async function revokeConnectionAction(formData: FormData): Promise<void> {
  const person = await requireModuleAccess("my-info");
  const id = formData.get("connectionId");
  if (typeof id !== "string" || !id) return;
  const owner = await connectionOwner(id);
  if (!owner) return;
  if (owner !== person.personId && !(await can(person.personId, "admin.access"))) return;
  await revokeConnection(id, person.personId, owner === person.personId ? "revoked by owner" : "revoked by admin");
  revalidatePath("/my-info/connections");
}
