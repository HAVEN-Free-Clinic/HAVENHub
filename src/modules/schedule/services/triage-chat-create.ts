/**
 * Create one weekly triage chat.
 *
 * Deliberately synchronous and NOT routed through notify()/drainTeamsQueue. That
 * queue retries on a fixed interval and falls back to email after an attempt
 * budget: retrying a create that partly succeeded would produce duplicate chats,
 * and there is no sensible email fallback for "create a group chat". A human is
 * watching this action and can simply be told what happened.
 */
import { prisma } from "@/platform/db";
import { Prisma } from "@prisma/client";
import { recordAudit } from "@/platform/audit";
import { log, errorAttrs } from "@/platform/logging";
import { mailConnectionStatus } from "@/platform/email/oauth";
import {
  createGroupChat as graphCreateGroupChat,
  postChatMessage as graphPostChatMessage,
  getSignedInUserId,
} from "@/platform/teams/group-chat";
import { loadTriageChatDraft, textToTeamsHtml, type TriageChatDraft } from "./triage-chat-draft";

/** Raised when a chat already exists for this preset and clinic date. */
export class TriageChatConflictError extends Error {
  constructor() {
    super("A triage chat has already been created for this preset and clinic date.");
    this.name = "TriageChatConflictError";
  }
}

/** Raised when the service account cannot be identified, so nobody could own the chat. */
export class TriageChatNotConnectedError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "TriageChatNotConnectedError";
  }
}

/**
 * Why a member who COULD have been added has no seat in the chat.
 *
 * Deliberately one reason covering two causes, because the two are genuinely
 * indistinguishable here: the ED unticked them on the review screen, or they
 * came onto the schedule between the review screen rendering and the confirm
 * (the draft is re-resolved at confirm, so the form could not have carried an
 * id that did not exist yet). Recorded so neither case is silent; kept OUT of
 * the reported failures so neither case nags.
 */
export const NOT_SELECTED_REASON =
  "Not selected on the review screen, or added to the schedule after it was opened.";

export type CreateTriageChatDeps = {
  loadDraft?: (presetId: string) => Promise<TriageChatDraft | null>;
  createGroupChat?: typeof graphCreateGroupChat;
  postChatMessage?: typeof graphPostChatMessage;
  serviceAccountId?: () => Promise<string>;
};

/**
 * The Entra object id of the connected service account.
 *
 * Read from /me, which resolves whoever the delegated token belongs to without
 * naming them. The stored account string is the mailbox address, and this
 * tenant's UPN and mail do not always match (hfc.admin@yale.edu by mail,
 * hfc.admin@yu.yale.edu by UPN), so binding on it was never reliable.
 */
async function defaultServiceAccountId(): Promise<string> {
  const status = await mailConnectionStatus();
  if (!status.connected || !status.account) {
    throw new TriageChatNotConnectedError(
      "No Microsoft account is connected. Connect the mailbox in Admin > Email before creating a chat.",
    );
  }
  const id = await getSignedInUserId();
  if (!id) {
    throw new TriageChatNotConnectedError(
      `The connected account ${status.account} could not be identified to Microsoft. Reconnect the mailbox in Admin > Email.`,
    );
  }
  return id;
}

export type CreateTriageChatResult = {
  triageChatId: string;
  chatId: string;
  webUrl: string;
  messagePosted: boolean;
  /** People Graph refused, named so the ED can add them by hand. */
  failures: { name: string; reason: string }[];
};

export async function createTriageChat(
  input: {
    presetId: string;
    actorPersonId: string;
    topic: string;
    messageBody: string;
    includePersonIds: string[];
    /**
     * The clinic date the review screen was built for, as a UTC day key.
     *
     * Optional only because a non-form caller has no page to have opened and so
     * no week to claim; the review form always sends it.
     */
    expectedClinicDateKey?: string;
  },
  deps: CreateTriageChatDeps = {},
): Promise<CreateTriageChatResult> {
  const {
    loadDraft = (presetId: string) => loadTriageChatDraft(presetId),
    createGroupChat = graphCreateGroupChat,
    postChatMessage = graphPostChatMessage,
    serviceAccountId = defaultServiceAccountId,
  } = deps;

  // Validate before anything expensive, and before the claim insert. `required`
  // on the review form is client-only, so an empty topic reaches here from a
  // tampered or scripted submit and creates an unnamed Teams chat that this
  // feature deliberately gives nobody a way to rename afterwards.
  const topic = input.topic.trim();
  const messageBody = input.messageBody.trim();
  if (!topic) throw new Error("The chat name cannot be empty.");
  if (!messageBody) throw new Error("The opening message cannot be empty.");

  // Re-resolve server side. The form contributes only a set of person ids to
  // KEEP; it never supplies identities or Entra ids, so a tampered field cannot
  // name an arbitrary person into the chat.
  const draft = await loadDraft(input.presetId);
  if (!draft) throw new Error("This preset has no clinic date to build a chat for.");

  // The draft re-derives the current clinic date from a fresh `now`, so the
  // week can roll over between an ED opening the review screen and confirming
  // it. The topic and message in hand still describe the old Saturday, and the
  // roster underneath the ticked checkboxes is a different set of people, so
  // this has to be refused rather than silently written against the new week.
  if (input.expectedClinicDateKey && input.expectedClinicDateKey !== draft.clinicDateKey) {
    throw new Error(
      `The clinic week changed while this page was open: it now builds the chat for ${draft.clinicDateKey}, not ${input.expectedClinicDateKey}. Reload the review screen and check the roster before creating the chat.`,
    );
  }

  const keep = new Set(input.includePersonIds);
  const selected = draft.resolved.filter((r) => keep.has(r.member.personId));

  const stored = selected.filter((r) => r.userId);
  // Built from the FULL roster, deliberately NOT from the keep-set. The review
  // form renders an unresolvable person's checkbox disabled, so they can never
  // appear in includePersonIds, and filtering them through the keep-set would
  // drop exactly the people the confirmation page exists to name. They are on
  // shift, they belong in the chat, and a human has to add them by hand: that
  // is only true if we record and report them.
  const unresolved = draft.resolved.filter((r) => !r.userId);
  // Resolvable, and yet not going in. Filtered on `r.userId` so an unresolvable
  // member cannot be recorded twice: the review form disables their checkbox, so
  // they are ALSO absent from the keep-set, and `unresolved` above already
  // covers them with the reason that actually explains their absence.
  const unkept = draft.resolved.filter((r) => r.userId && !keep.has(r.member.personId));

  if (stored.length === 0) {
    throw new Error("Nobody in this roster can be added to a chat.");
  }

  const ownerId = await serviceAccountId();

  // Every id here came from a real sign-in (Person.entraObjectId is written from
  // the oid claim at login), so the create can seat them all in one atomic call.
  // There is no second, less-trusted tier to add incrementally any more.
  const createMembers = stored;

  // Claim the week BEFORE calling Graph. The unique constraint is the guard: a
  // double submit loses the insert here rather than creating a second chat.
  let claimed;
  try {
    claimed = await prisma.triageChat.create({
      data: {
        presetId: input.presetId,
        termId: draft.term.id,
        clinicDate: draft.clinicDate,
        topic,
        messageBody,
        graphChatId: "",
        webUrl: "",
        createdById: input.actorPersonId,
      },
      select: { id: true },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new TriageChatConflictError();
    }
    throw err;
  }

  let chat: { chatId: string; webUrl: string };
  try {
    chat = await createGroupChat({
      topic,
      memberIds: [ownerId, ...createMembers.map((r) => r.userId!)],
    });
  } catch (err) {
    // Nothing exists in Teams, so the claim must go too or the week is locked
    // out of a retry that would have worked.
    await prisma.triageChat.delete({ where: { id: claimed.id } }).catch((deleteErr) => {
      // Deliberately not rethrown: the Graph error below is the one the ED needs
      // to see. But a failed rollback leaves a claim row with no chat id, and
      // every later attempt at this week then fails the unique constraint with
      // no way to clear it from the UI. Log so that is diagnosable instead of a
      // silent permanent lockout.
      log.error(
        "[triage-chats] failed to roll back the chat claim after a Graph create failure",
        errorAttrs(deleteErr, { triageChatId: claimed.id, presetId: input.presetId }),
      );
    });
    throw err;
  }

  // Record the chat id the instant Graph hands it over, BEFORE the member loop
  // and BEFORE the message post. The chat exists in Teams from this moment, so
  // the row has to say so before anything else can fail or be killed: on a
  // twenty-person roster the remaining work is twenty-plus sequential Graph
  // calls, and recording the id only at the end is what turns any later failure
  // into a real chat nobody can reach, behind a claim row that locks the week
  // out of the UI with no way to clear it.
  await prisma.triageChat.update({
    where: { id: claimed.id },
    data: { graphChatId: chat.chatId, webUrl: chat.webUrl },
  });

  const failures: { name: string; reason: string }[] = [];
  const memberRows: Prisma.TriageChatMemberCreateManyInput[] = createMembers.map((r) => ({
    triageChatId: claimed.id,
    personId: r.member.personId,
    personName: r.member.name,
    departmentName: r.member.departmentName,
    addedOk: true,
  }));


  for (const r of unresolved) {
    const reason = r.reason ?? "Could not be resolved to a Microsoft account.";
    failures.push({ name: r.member.name, reason });
    memberRows.push({
      triageChatId: claimed.id,
      personId: r.member.personId,
      personName: r.member.name,
      departmentName: r.member.departmentName,
      addedOk: false,
      error: reason,
    });
  }

  // Recorded, never reported. These people are resolvable and simply have no
  // seat: telling an ED to "add them by hand" would nag them about someone they
  // deliberately unticked. The row is the record that they were considered.
  for (const r of unkept) {
    memberRows.push({
      triageChatId: claimed.id,
      personId: r.member.personId,
      personName: r.member.name,
      departmentName: r.member.departmentName,
      addedOk: false,
      error: NOT_SELECTED_REASON,
    });
  }

  let messagePosted = false;
  try {
    await postChatMessage(chat.chatId, textToTeamsHtml(messageBody));
    messagePosted = true;
  } catch (err) {
    // Keep the row. That is the whole point: with graphChatId recorded, a retry
    // posts the message instead of creating a second chat.
    log.error("[triage-chats] opening message failed", errorAttrs(err, { chatId: chat.chatId }));
  }

  // graphChatId and webUrl are deliberately NOT set here: they were written the
  // moment Graph returned them, above.
  await prisma.$transaction([
    prisma.triageChat.update({
      where: { id: claimed.id },
      data: { messagePostedAt: messagePosted ? new Date() : null },
    }),
    prisma.triageChatMember.createMany({ data: memberRows }),
  ]);

  await recordAudit({
    actorPersonId: input.actorPersonId,
    action: "triage_chat.create",
    entityType: "TriageChat",
    entityId: claimed.id,
    after: {
      topic,
      clinicDate: draft.clinicDateKey,
      membersAdded: memberRows.filter((m) => m.addedOk).length,
      membersFailed: failures.length,
      // Separate from membersFailed on purpose: nobody needs to act on these,
      // but a roster that quietly shrank between review and confirm should be
      // countable after the fact.
      membersNotSelected: unkept.length,
      messagePosted,
    },
  });

  return {
    triageChatId: claimed.id,
    chatId: chat.chatId,
    webUrl: chat.webUrl,
    messagePosted,
    failures,
  };
}

/**
 * Post the opening message for a chat that was created without one.
 *
 * Takes no messageBody: the row already carries the text exactly as the ED
 * approved it on the review screen, which is what a retry must post. Reading it
 * from the row (rather than accepting it as a parameter) means no caller can
 * pass something the ED never saw.
 */
export async function retryTriageChatMessage(
  triageChatId: string,
  deps: { postChatMessage?: typeof graphPostChatMessage } = {},
): Promise<void> {
  const post = deps.postChatMessage ?? graphPostChatMessage;
  const chat = await prisma.triageChat.findUniqueOrThrow({
    where: { id: triageChatId },
    select: { graphChatId: true, messagePostedAt: true, messageBody: true },
  });
  if (chat.messagePostedAt) return;
  // A row with no Graph chat id is a claim whose creation died between the
  // Graph call and the database write. There is no chat to post into, and
  // posting to "" would be a Graph request with an empty path segment.
  if (!chat.graphChatId) {
    throw new Error(
      "This triage chat has no Microsoft Teams chat id recorded, so its message cannot be posted. The record is incomplete and needs an administrator.",
    );
  }
  // An atomic claim, NOT a read-then-write. Two clicks on the confirmation
  // page's Post button both read messagePostedAt as null a moment apart, and a
  // plain guard lets both through: twenty people get the opening message twice.
  // Taking the timestamp inside a conditional updateMany means exactly one
  // caller wins and the loser returns without posting.
  const claimedAt = new Date();
  const claim = await prisma.triageChat.updateMany({
    where: { id: triageChatId, messagePostedAt: null },
    data: { messagePostedAt: claimedAt },
  });
  if (claim.count === 0) return;
  try {
    await post(chat.graphChatId, textToTeamsHtml(chat.messageBody));
  } catch (err) {
    // Release the claim so a later retry can try again, but only if it is still
    // ours. Scoping the release to our own timestamp means we can never clear a
    // concurrent winner's successful post.
    await prisma.triageChat.updateMany({
      where: { id: triageChatId, messagePostedAt: claimedAt },
      data: { messagePostedAt: null },
    });
    throw err;
  }
}
