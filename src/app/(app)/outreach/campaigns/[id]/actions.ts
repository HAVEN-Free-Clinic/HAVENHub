"use server";

/**
 * Campaign editor server actions.
 *
 * These live in their own module, at module scope, for a reason that is not
 * stylistic: a helper declared inside the page component and referenced from a
 * "use server" closure gets serialized as an encrypted bound argument, and a
 * function is not serializable. That compiles cleanly and then kills every
 * action on the page at runtime -- the page still renders, but the server
 * throws "Functions cannot be passed directly to Client Components" and every
 * form's action becomes `javascript:throw new Error(...)`. It shipped once
 * already.
 *
 * Every exported action below takes the campaign id and its bound scope id as
 * explicit leading parameters instead of closing over render scope. The page
 * supplies them with `.bind(null, id, scopeId)`, which is the sanctioned way
 * to pass extra arguments to a Server Action referenced from a form -- see
 * https://react.dev/reference/react-dom/hooks/useFormStatus and the Next.js
 * Server Actions docs' "Passing additional arguments" section. Binding
 * primitives this way is not the pitfall above: the pitfall is specifically a
 * *function* captured from render scope, not a string or null.
 */

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireAnyPermission } from "@/platform/auth/session";
import {
  updateCampaign,
  previewAudience,
  countAudienceNodes,
  testSend,
  sendCampaignNow,
  scheduleCampaign,
  cancelCampaign,
  assertMayActOnScope,
  CampaignValidationError,
  CampaignConfirmationError,
  CampaignScopeError,
} from "@/platform/email/campaigns/service";
import { isAudience, EMPTY_AUDIENCE } from "@/platform/email/audience/types";
import type { Audience } from "@/platform/email/audience/types";
import { parseZonedInput } from "@/platform/dates";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import type { PreviewResult } from "./review-actions";
import type { EditorTab } from "./tabs";

/**
 * Which editor tab a save should redirect back to. Read from a hidden "tab"
 * field inside the compose form rather than threaded through as a bound
 * argument, because -- unlike id/scopeId -- it changes on every render (it
 * tracks whichever tab the page most recently rendered as active) and a bound
 * argument is fixed at bind time. Every section stays mounted regardless of
 * the active tab (see tabs.tsx), so this field is always present in the
 * submitted FormData no matter which panel was visible when Save was clicked.
 */
function resolveTab(raw: FormDataEntryValue | null): EditorTab {
  return raw === "audience" ? "audience" : raw === "review" ? "review" : "compose";
}

// Module scope, NOT a closure inside the page component: a "use server" action
// closure can only capture serializable values (Next's transform bundles every
// render-scope identifier an action references as an encrypted bound
// argument), and a plain function reference is not serializable. This used to
// be declared inside CampaignEditorPage's body, which made every action below
// that called it dead at runtime -- the page rendered, but the server threw
// "Functions cannot be passed directly to Client Components" and emitted each
// form's action as `javascript:throw new Error(...)`. Hoisted here and given
// its own explicit, serializable arguments instead of closing over them.
//
// The same predicate CampaignValidationError/CampaignConfirmationError already
// get at each call site below: a blocked sender sees an inline explanation via
// ?error=, not the generic error boundary. Every mutating action shares this
// exact predicate, since a scoped sender may not edit, cancel, preview, or
// send/schedule a campaign outside their granted scopes any more than they may
// view one.
async function assertScopeOrRedirect(
  personId: string,
  scopeId: string | null,
  id: string,
): Promise<void> {
  try {
    await assertMayActOnScope(personId, scopeId);
  } catch (err) {
    if (err instanceof CampaignScopeError) {
      redirect(`/outreach/campaigns/${id}?error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }
}

export async function saveAction(
  id: string,
  scopeId: string | null,
  formData: FormData,
): Promise<void> {
  const actor = await requireAnyPermission(["outreach.send", "outreach.send_unrestricted"]);
  await assertScopeOrRedirect(actor.personId, scopeId, id);
  const tab = resolveTab(formData.get("tab"));
  const name = ((formData.get("name") as string | null) ?? "").trim();
  const subject = (formData.get("subject") as string | null) ?? "";
  const body = (formData.get("body") as string | null) ?? "";
  const sendOncePerPerson = formData.get("sendOncePerPerson") === "on";
  let audience: Audience;
  try {
    const raw = JSON.parse((formData.get("audience") as string | null) ?? "{}");
    audience = isAudience(raw) ? raw : EMPTY_AUDIENCE;
  } catch {
    audience = EMPTY_AUDIENCE;
  }

  try {
    await updateCampaign(actor.personId, id, {
      name: name || undefined,
      subject,
      body,
      audience,
      sendOncePerPerson,
    });
  } catch (err) {
    if (err instanceof CampaignValidationError) {
      redirect(
        `/outreach/campaigns/${id}?tab=${tab}&error=${encodeURIComponent(err.problems.join("; "))}`,
      );
    }
    throw err;
  }

  revalidatePath(`/outreach/campaigns/${id}`);
  redirect(`/outreach/campaigns/${id}?tab=${tab}&saved=1`);
}

// Returns the resolved roll rather than redirecting: ReviewActions renders it
// in place. A redirect could only carry a count, and the global FlashReader
// strips the params as soon as it toasts them, leaving nothing to render from.
export async function previewAction(
  id: string,
  scopeId: string | null,
): Promise<PreviewResult> {
  const actor = await requireAnyPermission(["outreach.send", "outreach.send_unrestricted"]);
  try {
    // A preview lists real recipient names, so it needs the same scope check
    // as an actual send -- returned as a `problems` entry rather than a
    // redirect, matching how this action already reports every other failure.
    await assertMayActOnScope(actor.personId, scopeId);
    return { ok: true, preview: await previewAudience(id) };
  } catch (err) {
    if (err instanceof CampaignScopeError) return { ok: false, problems: [err.message] };
    if (err instanceof CampaignValidationError) return { ok: false, problems: err.problems };
    throw err;
  }
}

/**
 * Live per-node match counts for the tree the sender is editing, for the
 * audience builder.
 *
 * The one action on this page that takes an audience from the client, because
 * it counts a tree that has not been saved yet. It keeps exactly the split
 * previewAction uses above: the BOUND `scopeId` is used only to re-check
 * permission via assertMayActOnScope, while the scope the counts are actually
 * resolved against is read from the campaign row inside countAudienceNodes.
 * Nothing in `audience` reaches that decision, and there is deliberately no
 * scope parameter here for a caller to supply one.
 *
 * Failures come back as an empty map rather than a thrown error or a redirect.
 * These counts are ambient decoration on a page a sender already had to pass
 * the same scope check to open (see page.tsx), so the only way to arrive here
 * unauthorized is a grant that changed mid-session; showing no numbers is the
 * fail-closed outcome, and every action that actually sends anything still
 * refuses loudly.
 */
export async function countNodesAction(
  id: string,
  scopeId: string | null,
  audience: Audience,
): Promise<Record<string, number>> {
  const actor = await requireAnyPermission(["outreach.send", "outreach.send_unrestricted"]);
  try {
    await assertMayActOnScope(actor.personId, scopeId);
    return await countAudienceNodes(id, audience);
  } catch (err) {
    if (err instanceof CampaignScopeError) return {};
    if (err instanceof CampaignValidationError) return {};
    throw err;
  }
}

export async function testAction(id: string, scopeId: string | null): Promise<void> {
  const actor = await requireAnyPermission(["outreach.send", "outreach.send_unrestricted"]);
  await assertScopeOrRedirect(actor.personId, scopeId, id);
  if (!actor.email) {
    redirect(
      `/outreach/campaigns/${id}?tab=review&error=${encodeURIComponent("Your account has no email address on file.")}`,
    );
  }
  try {
    await testSend(actor.personId, id, actor.email);
  } catch {
    redirect(
      `/outreach/campaigns/${id}?tab=review&error=${encodeURIComponent("Test send failed. Check that the campaign has a subject and body.")}`,
    );
  }
  redirect(`/outreach/campaigns/${id}?tab=review&tested=1#review`);
}

export async function sendAction(
  id: string,
  scopeId: string | null,
  formData: FormData,
): Promise<void> {
  const actor = await requireAnyPermission(["outreach.send", "outreach.send_unrestricted"]);
  await assertScopeOrRedirect(actor.personId, scopeId, id);
  const rawCount = formData.get("confirmCount");
  const confirmCount =
    rawCount !== null && rawCount !== "" ? Number(rawCount) : undefined;

  let recipientCount = 0;
  try {
    const result = await sendCampaignNow(actor.personId, id, { confirmCount });
    recipientCount = result.recipientCount;
  } catch (err) {
    if (err instanceof CampaignConfirmationError) {
      redirect(
        `/outreach/campaigns/${id}?tab=review&error=${encodeURIComponent(
          `This campaign targets ${err.expected} recipients. Type ${err.expected} in the confirmation field and click Send again.`,
        )}`,
      );
    }
    if (err instanceof CampaignValidationError) {
      redirect(
        `/outreach/campaigns/${id}?tab=review&error=${encodeURIComponent(err.problems.join("; "))}`,
      );
    }
    throw err;
  }

  revalidatePath("/outreach/campaigns");
  redirect(`/outreach/campaigns/${id}?sent=${recipientCount}`);
}

export async function scheduleLaterAction(
  id: string,
  scopeId: string | null,
  formData: FormData,
): Promise<void> {
  const actor = await requireAnyPermission(["outreach.send", "outreach.send_unrestricted"]);
  await assertScopeOrRedirect(actor.personId, scopeId, id);
  const raw = (formData.get("scheduledAt") as string | null) ?? "";
  if (!raw) redirect(`/outreach/campaigns/${id}?tab=review&error=${encodeURIComponent("Pick a date and time")}`);
  const scheduledAt = parseZonedInput(raw, await getDisplayTimeZone());
  if (!scheduledAt) {
    redirect(`/outreach/campaigns/${id}?tab=review&error=${encodeURIComponent("Pick a valid date and time")}`);
  }
  const rawCount = formData.get("confirmCount");
  const confirmCount = rawCount !== null && rawCount !== "" ? Number(rawCount) : undefined;
  try {
    await scheduleCampaign(actor.personId, id, { scheduleType: "SCHEDULED", scheduledAt }, undefined, { confirmCount });
  } catch (err) {
    if (err instanceof CampaignConfirmationError) {
      redirect(`/outreach/campaigns/${id}?tab=review&error=${encodeURIComponent(`This campaign targets ${err.expected} recipients. Type ${err.expected} in the confirmation field and schedule again.`)}`);
    }
    if (err instanceof CampaignValidationError) {
      redirect(`/outreach/campaigns/${id}?tab=review&error=${encodeURIComponent(err.problems.join("; "))}`);
    }
    throw err;
  }
  revalidatePath(`/outreach/campaigns/${id}`);
  redirect(`/outreach/campaigns/${id}?scheduled=1`);
}

export async function scheduleRecurringAction(
  id: string,
  scopeId: string | null,
  formData: FormData,
): Promise<void> {
  const actor = await requireAnyPermission(["outreach.send", "outreach.send_unrestricted"]);
  await assertScopeOrRedirect(actor.personId, scopeId, id);
  const cronExpr = ((formData.get("cronExpr") as string | null) ?? "").trim();
  const rawCount = formData.get("confirmCount");
  const confirmCount = rawCount !== null && rawCount !== "" ? Number(rawCount) : undefined;
  try {
    await scheduleCampaign(actor.personId, id, { scheduleType: "RECURRING", cronExpr }, undefined, { confirmCount });
  } catch (err) {
    if (err instanceof CampaignConfirmationError) {
      redirect(`/outreach/campaigns/${id}?tab=review&error=${encodeURIComponent(`This campaign targets ${err.expected} recipients. Type ${err.expected} in the confirmation field and start recurring again.`)}`);
    }
    if (err instanceof CampaignValidationError) {
      redirect(`/outreach/campaigns/${id}?tab=review&error=${encodeURIComponent(err.problems.join("; "))}`);
    }
    throw err;
  }
  revalidatePath(`/outreach/campaigns/${id}`);
  redirect(`/outreach/campaigns/${id}?scheduled=1`);
}

export async function cancelAction(id: string, scopeId: string | null): Promise<void> {
  const actor = await requireAnyPermission(["outreach.send", "outreach.send_unrestricted"]);
  await assertScopeOrRedirect(actor.personId, scopeId, id);
  try {
    await cancelCampaign(actor.personId, id);
  } catch (err) {
    if (err instanceof CampaignValidationError) {
      redirect(`/outreach/campaigns/${id}?error=${encodeURIComponent(err.problems.join("; "))}`);
    }
    throw err;
  }
  revalidatePath(`/outreach/campaigns/${id}`);
  redirect(`/outreach/campaigns/${id}?cancelled=1`);
}
