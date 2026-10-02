"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/platform/auth/session";
import { config } from "@/platform/config";
import { createForm } from "@/modules/forms/service";
import { importAirtableTable, parseAirtableRef, AirtableImportError } from "@/modules/forms/airtable-import";
import { FormLayoutError } from "@/modules/forms/layout";

export async function createFormAction(formData: FormData): Promise<void> {
  const actor = await requirePermission("forms.manage");
  const { id } = await createForm(actor.personId, {
    title: String(formData.get("title") ?? ""),
    templateId: String(formData.get("templateId") ?? "") || null,
  });
  revalidatePath("/forms");
  redirect(`/forms/${id}`);
}

export async function importAirtableAction(formData: FormData): Promise<void> {
  const actor = await requirePermission("forms.manage");
  const ref = parseAirtableRef(String(formData.get("airtable") ?? ""));
  if (!ref) {
    redirect(`/forms/new?error=${encodeURIComponent("Paste an Airtable link (or base and table ids) that includes both app… and tbl….")}`);
  }
  if (!config.AIRTABLE_PAT) {
    redirect(`/forms/new?error=${encodeURIComponent("The Hub has no Airtable token configured (AIRTABLE_PAT).")}`);
  }
  let formId: string;
  let summary: string;
  try {
    const result = await importAirtableTable(actor.personId, {
      pat: config.AIRTABLE_PAT,
      baseId: ref.baseId,
      tableId: ref.tableId,
      title: String(formData.get("title") ?? ""),
    });
    formId = result.formId;
    summary = `${result.imported}-${result.matched}`;
  } catch (err) {
    if (err instanceof AirtableImportError) redirect(`/forms/new?error=${encodeURIComponent(err.message)}`);
    if (err instanceof FormLayoutError) redirect(`/forms/new?error=${encodeURIComponent(err.problems.join(" "))}`);
    throw err;
  }
  revalidatePath("/forms");
  redirect(`/forms/${formId}?tab=responses&imported=${summary}`);
}
