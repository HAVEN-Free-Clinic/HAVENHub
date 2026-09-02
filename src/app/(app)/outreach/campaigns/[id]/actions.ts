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
  searchAudiencePeople,
  editManualLists,
  testSend,
  sendCampaignNow,
  scheduleCampaign,
  cancelCampaign,
  assertMayActOnScope,
  CampaignValidationError,
  CampaignConfirmationError,
  CampaignScopeError,
} from "@/platform/email/campaigns/service";
import { SenderIdentityError } from "@/platform/email/sender-identity";
import type { PersonSearchHit } from "@/platform/email/audience/resolve";
import { UnknownAudienceFieldError } from "@/platform/email/audience/person-fields";
import { isAudience, EMPTY_AUDIENCE } from "@/platform/email/audience/types";
import type { Audience } from "@/platform/email/audience/types";
import { parseZonedInput } from "@/platform/dates";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import type { PreviewResult } from "./review-actions";
import type { FormProblems } from "./form-state";
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

/**
 * The scope check for the actions that must not navigate when they refuse.
 *
 * Same predicate as assertScopeOrRedirect above, same failure, different
 * delivery: the reason comes back as a string for the caller to render, rather
 * than as a redirect that would take the sender's unsaved work with it. Used by
 * saveAction and pastedEmailsAction; every other action here still redirects,
 * because none of them can be reached with unsaved state on the page that a
 * navigation would destroy.
 */
async function scopeProblems(
  personId: string,
  scopeId: string | null,
): Promise<string[] | null> {
  try {
    await assertMayActOnScope(personId, scopeId);
    return null;
  } catch (err) {
    if (err instanceof CampaignScopeError) return [err.message];
    throw err;
  }
}

/**
 * Save the compose form.
 *
 * RETURNS its problems rather than redirecting with them, which is the whole
 * point of the signature: this action is reached with the sender's entire
 * unsaved draft held in client state (TemplateEditor's subject and body,
 * AudienceBuilder's whole tree), and on this route a redirect replaces the page
 * tree below AppShell through the (app)/loading.tsx Suspense boundary. A
 * mistyped template variable is the most ordinary way to reach a refusal, and
 * redirecting on it destroyed everything typed since the last save while
 * showing a toast about a variable name. previewAction has always returned its
 * problems for a related reason; this action was the odd one out.
 *
 * Success still redirects, and should: the work is stored by then, and the
 * redirect is what re-seeds the editor from it.
 *
 * The leading `prevState` is useActionState's calling convention (see
 * compose-form.tsx). It is unused: everything this action needs is in the
 * FormData.
 */
export async function saveAction(
  id: string,
  scopeId: string | null,
  _prevState: FormProblems,
  formData: FormData,
): Promise<FormProblems> {
  const actor = await requireAnyPermission(["outreach.send", "outreach.send_unrestricted"]);
  const refused = await scopeProblems(actor.personId, scopeId);
  if (refused) return { problems: refused };
  const tab = resolveTab(formData.get("tab"));
  const name = ((formData.get("name") as string | null) ?? "").trim();
  const subject = (formData.get("subject") as string | null) ?? "";
  const body = (formData.get("body") as string | null) ?? "";
  const sendOncePerPerson = formData.get("sendOncePerPerson") === "on";
  // The chosen sending identity, or "" for the resolution default. Passed
  // through unvalidated ON PURPOSE: updateCampaign authorizes it against the
  // campaign's own scope, and doing it there rather than here is what makes the
  // check hold for every caller instead of only for this form. A hand-crafted
  // value is exactly what that check exists to refuse.
  const fromEmail = ((formData.get("fromEmail") as string | null) ?? "").trim();
  let audience: Audience;
  try {
    const raw = JSON.parse((formData.get("audience") as string | null) ?? "{}");
    audience = isAudience(raw) ? raw : EMPTY_AUDIENCE;
  } catch {
    audience = EMPTY_AUDIENCE;
  }

  // Checked here rather than with the browser's `required` attribute, which is
  // what guarded this before. That attribute cannot report a reason the server
  // knows, and it refuses to submit at all when the control it names sits in a
  // hidden tab panel: the sender got "An invalid form control with name='name'
  // is not focusable" in the console and a Save button that silently did
  // nothing. Returned on its own rather than merged with the template problems
  // below, because updateCampaign must not run while the name is missing, so
  // there is nothing yet to merge it with.
  if (name === "") return { problems: ["Enter a campaign name."] };

  try {
    await updateCampaign(actor.personId, id, {
      name,
      subject,
      body,
      audience,
      sendOncePerPerson,
      fromEmail,
    });
  } catch (err) {
    if (err instanceof CampaignValidationError) return { problems: err.problems };
    // Returned, not redirected, for the same reason every other refusal here is:
    // the sender's entire unsaved draft is in client state and a redirect would
    // take it with them. A refused identity is also the one refusal a sender can
    // reach without doing anything odd -- an address issued to them and then
    // revoked while the editor was open lands here.
    if (err instanceof SenderIdentityError) return { problems: [err.message] };
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
 *
 * UnknownAudienceFieldError is degraded for a different reason, and it matters
 * that it is degraded HERE rather than left to reject: unlike a preview, this
 * action fires automatically on every editor load, and a stored audience naming
 * a retired field is a legacy state the builder is specifically built to render
 * (field-picker.tsx shows it as "Unknown field" with a control to remove it).
 * Rejecting would mean a server action failing on load for exactly the audience
 * a sender opened the page to repair. Caught by type, so a wiring bug anywhere
 * else in the compiler still surfaces.
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
    if (err instanceof UnknownAudienceFieldError) return {};
    throw err;
  }
}

/**
 * The scoped person search behind the manual-include control.
 *
 * Same split as previewAction and countNodesAction: the BOUND `scopeId` is used
 * only to re-check permission, while the scope the search is actually bounded
 * by is read from the campaign row inside searchAudiencePeople. There is
 * deliberately no scope parameter here, because a search a caller could
 * unscope would let a scoped sender enumerate the whole directory a letter at a
 * time -- and learning who exists is the leak, even though every send stays
 * scope-filtered regardless.
 *
 * Fails closed to an empty list for the same reason countNodesAction does: this
 * runs as the sender types, on a page they already passed the identical scope
 * check to open, so the only way to arrive here unauthorized is a grant that
 * changed mid-session. Showing no results is the fail-closed answer, and every
 * action that mutates a list or sends anything still refuses loudly.
 */
export async function searchPeopleAction(
  id: string,
  scopeId: string | null,
  query: string,
): Promise<PersonSearchHit[]> {
  const actor = await requireAnyPermission(["outreach.send", "outreach.send_unrestricted"]);
  try {
    await assertMayActOnScope(actor.personId, scopeId);
    return await searchAudiencePeople(id, query);
  } catch (err) {
    if (err instanceof CampaignScopeError) return [];
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Manual list edits.
//
// Four separate actions rather than one taking an op, so each form on the page
// names the thing it does. Every one of them carries the same gate as the seven
// actions above -- a scoped sender may no more edit another department's
// recipient list than they may preview, edit, or send that campaign -- and each
// takes id and scopeId as explicit leading parameters for the module-scope
// reason documented at the top of this file.
//
// All four redirect back to ?tab=audience: they are driven from controls that
// only exist on that tab, and landing the sender on Compose after excluding a
// row would lose their place in a list they are working down.
// ---------------------------------------------------------------------------

export async function includePersonAction(
  id: string,
  scopeId: string | null,
  formData: FormData,
): Promise<void> {
  const actor = await requireAnyPermission(["outreach.send", "outreach.send_unrestricted"]);
  await assertScopeOrRedirect(actor.personId, scopeId, id);
  const personId = ((formData.get("personId") as string | null) ?? "").trim();
  if (personId !== "") {
    await editManualLists(actor.personId, id, { op: "include", personId });
  }
  revalidatePath(`/outreach/campaigns/${id}`);
  redirect(`/outreach/campaigns/${id}?tab=audience`);
}

export async function excludePersonAction(
  id: string,
  scopeId: string | null,
  formData: FormData,
): Promise<void> {
  const actor = await requireAnyPermission(["outreach.send", "outreach.send_unrestricted"]);
  await assertScopeOrRedirect(actor.personId, scopeId, id);
  const personId = ((formData.get("personId") as string | null) ?? "").trim();
  if (personId !== "") {
    await editManualLists(actor.personId, id, { op: "exclude", personId });
  }
  revalidatePath(`/outreach/campaigns/${id}`);
  redirect(`/outreach/campaigns/${id}?tab=audience`);
}

/**
 * Clears the whole exclusion list, which is the editor's only undo for it.
 *
 * All-or-nothing on purpose. Per-row restore would mean rendering the excluded
 * people by name, and a name is exactly what this page must not echo back for
 * an id the sender supplied: a forged personId would come back with the name
 * attached, turning the undo list into the directory oracle the search box is
 * so carefully not. A count of ids the sender themselves wrote reveals nothing
 * they did not already have.
 */
export async function clearExcludedAction(id: string, scopeId: string | null): Promise<void> {
  const actor = await requireAnyPermission(["outreach.send", "outreach.send_unrestricted"]);
  await assertScopeOrRedirect(actor.personId, scopeId, id);
  await editManualLists(actor.personId, id, { op: "clearExcluded" });
  revalidatePath(`/outreach/campaigns/${id}`);
  redirect(`/outreach/campaigns/${id}?tab=audience`);
}

/**
 * Save the pasted-address block.
 *
 * Returns its problems for the same reason saveAction does, and the case that
 * forces it is exact: the only refusal here is "that is more than
 * MAX_PASTED_EMAILS addresses", and redirecting with that message destroyed the
 * very block it was complaining about. The sender pasted six hundred addresses
 * and was told to paste fewer, with nothing left to trim.
 */
export async function pastedEmailsAction(
  id: string,
  scopeId: string | null,
  _prevState: FormProblems,
  formData: FormData,
): Promise<FormProblems> {
  const actor = await requireAnyPermission(["outreach.send", "outreach.send_unrestricted"]);
  const refused = await scopeProblems(actor.personId, scopeId);
  if (refused) return { problems: refused };
  const raw = (formData.get("pastedEmails") as string | null) ?? "";
  // Newlines, commas, semicolons, and whitespace all separate addresses: a
  // sender pasting out of a spreadsheet column, an email client's To: field, or
  // a wrapped list should not have to reformat it first.
  const emails = raw.split(/[\s,;]+/).filter((e) => e !== "");
  try {
    await editManualLists(actor.personId, id, { op: "paste", emails });
  } catch (err) {
    if (err instanceof CampaignValidationError) return { problems: err.problems };
    throw err;
  }
  revalidatePath(`/outreach/campaigns/${id}`);
  redirect(`/outreach/campaigns/${id}?tab=audience`);
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
