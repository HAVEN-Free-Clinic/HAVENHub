"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/platform/auth/session";
import { parseZonedInput } from "@/platform/dates";
import { formatDateTime } from "@/platform/dates/format";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import { countAudienceNodes } from "@/platform/email/audience/resolve";
import { isAudience, EMPTY_AUDIENCE, type Audience } from "@/platform/email/audience/types";
import { FormLayoutError } from "@/modules/forms/layout";
import {
  assignByAudience,
  assignByIdentifiers,
  deleteForm,
  duplicateForm,
  remindNonResponders,
  setFormStatus,
  unassign,
  updateForm,
  FormConflictError,
  FormError,
  type AssignResult,
} from "@/modules/forms/service";
import type { BuilderState } from "./form-builder";

/**
 * Form editor server actions. Module scope with the id bound by the page, for
 * the reason outreach/campaigns/[id]/actions.ts documents at length.
 */

const page = (id: string, tab?: string) => `/forms/${id}${tab ? `?tab=${tab}` : ""}`;

export async function saveFormAction(id: string, _prev: BuilderState, formData: FormData): Promise<BuilderState> {
  const actor = await requirePermission("forms.manage");
  let layout: unknown;
  try {
    layout = JSON.parse(String(formData.get("layout") ?? "{}"));
  } catch {
    return { problems: ["The form could not be read. Reload and try again."] };
  }
  const zone = await getDisplayTimeZone();
  const rawCloses = String(formData.get("closesAt") ?? "");
  const closesAt = rawCloses ? parseZonedInput(rawCloses, zone) : null;
  if (rawCloses && !closesAt) return { problems: ["Pick a valid closing date and time."] };
  const rawVersion = formData.get("layoutVersion");
  const expectedVersion =
    formData.get("overwrite") === "1" || rawVersion === null ? undefined : Number(rawVersion);

  try {
    await updateForm(actor.personId, id, {
      title: String(formData.get("title") ?? ""),
      description: String(formData.get("description") ?? ""),
      layout,
      openToAnyone: formData.get("openToAnyone") === "on",
      allowEdits: formData.get("allowEdits") === "on",
      closesAt,
      expectedVersion: Number.isFinite(expectedVersion) ? expectedVersion : undefined,
    });
  } catch (err) {
    if (err instanceof FormConflictError) {
      return {
        conflict: true,
        problems: [
          `${err.savedByName ?? "Someone else"} saved this form at ${formatDateTime(err.savedAt, zone)}, after you opened it. Your changes are NOT saved yet. Save anyway to replace their version, or reload to see theirs.`,
        ],
      };
    }
    if (err instanceof FormLayoutError) return { problems: err.problems };
    if (err instanceof FormError) return { problems: err.problems };
    throw err;
  }
  revalidatePath(`/forms/${id}`);
  redirect(`${page(id, "build")}&saved=1`);
}

export async function setStatusAction(id: string, formData: FormData): Promise<void> {
  const actor = await requirePermission("forms.manage");
  const raw = String(formData.get("status") ?? "");
  const status = raw === "OPEN" || raw === "CLOSED" || raw === "DRAFT" ? raw : null;
  if (!status) redirect(page(id));
  try {
    await setFormStatus(actor.personId, id, status);
  } catch (err) {
    if (err instanceof FormError || err instanceof FormLayoutError) {
      redirect(`/forms/${id}?error=${encodeURIComponent(err instanceof FormError ? err.problems.join(" ") : err.problems.join(" "))}`);
    }
    throw err;
  }
  revalidatePath(`/forms/${id}`);
  revalidatePath("/forms");
  redirect(`/forms/${id}?formStatus=${status.toLowerCase()}`);
}

export async function duplicateFormAction(id: string): Promise<void> {
  const actor = await requirePermission("forms.manage");
  const copy = await duplicateForm(actor.personId, id);
  revalidatePath("/forms");
  redirect(`/forms/${copy.id}?duplicated=1`);
}

export async function deleteFormAction(id: string): Promise<void> {
  const actor = await requirePermission("forms.manage");
  try {
    await deleteForm(actor.personId, id);
  } catch (err) {
    if (err instanceof FormError) redirect(`/forms/${id}?error=${encodeURIComponent(err.problems.join(" "))}`);
    throw err;
  }
  revalidatePath("/forms");
  redirect("/forms?deleted=1");
}

export type AssignState = (AssignResult & { error?: never }) | { error: string } | null;

export async function assignAudienceAction(id: string, _prev: AssignState, formData: FormData): Promise<AssignState> {
  const actor = await requirePermission("forms.manage");
  let audience: Audience;
  try {
    const raw = JSON.parse(String(formData.get("audience") ?? "{}"));
    audience = isAudience(raw) ? raw : EMPTY_AUDIENCE;
  } catch {
    audience = EMPTY_AUDIENCE;
  }
  if (audience.conditions.length === 0) return { error: "Add at least one condition to choose who to assign." };
  const result = await assignByAudience(actor.personId, id, audience, { notify: formData.get("notify") === "on" });
  revalidatePath(`/forms/${id}`);
  return result;
}

export async function assignListAction(id: string, _prev: AssignState, formData: FormData): Promise<AssignState> {
  const actor = await requirePermission("forms.manage");
  const identifiers = [
    ...new Set(
      String(formData.get("identifiers") ?? "")
        .split(/[\s,;]+/)
        .map((v) => v.trim().replace(/^<|>$/g, ""))
        .filter(Boolean),
    ),
  ];
  if (identifiers.length === 0) return { error: "Paste at least one NetID or email." };
  const result = await assignByIdentifiers(actor.personId, id, identifiers, { notify: formData.get("notify") === "on" });
  revalidatePath(`/forms/${id}`);
  return result;
}

/** Live per-node counts for the audience builder, unscoped like the assignment itself. */
export async function countAssignNodesAction(_id: string, audience: Audience): Promise<Record<string, number>> {
  await requirePermission("forms.manage");
  try {
    return await countAudienceNodes(audience);
  } catch {
    return {};
  }
}

export async function unassignAction(id: string, formData: FormData): Promise<void> {
  const actor = await requirePermission("forms.manage");
  const personId = String(formData.get("personId") ?? "");
  if (personId) await unassign(actor.personId, id, personId);
  revalidatePath(`/forms/${id}`);
  redirect(page(id, "assign"));
}

export async function remindAction(id: string): Promise<void> {
  const actor = await requirePermission("forms.manage");
  let emailed: number;
  try {
    emailed = await remindNonResponders(actor.personId, id);
  } catch (err) {
    if (err instanceof FormError) redirect(`${page(id, "assign")}&error=${encodeURIComponent(err.problems.join(" "))}`);
    throw err;
  }
  revalidatePath(`/forms/${id}`);
  redirect(`${page(id, "assign")}&reminded=${emailed}`);
}
