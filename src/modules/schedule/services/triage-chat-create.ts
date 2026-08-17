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
  addChatMember as graphAddChatMember,
  postChatMessage as graphPostChatMessage,
  lookupUserId,
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

export type CreateTriageChatDeps = {
  loadDraft?: (presetId: string) => Promise<TriageChatDraft | null>;
  createGroupChat?: typeof graphCreateGroupChat;
  addChatMember?: typeof graphAddChatMember;
  postChatMessage?: typeof graphPostChatMessage;
  serviceAccountId?: () => Promise<string>;
};

/**
 * The Entra object id of the connected service account.
 *
 * Resolved through the directory rather than binding the stored account string
 * directly: that string is the mailbox address, and this tenant's UPN and mail
 * do not always match (hfc.admin@yale.edu by mail, hfc.admin@yu.yale.edu by UPN).
 */
async function defaultServiceAccountId(): Promise<string> {
  const status = await mailConnectionStatus();
  if (!status.connected || !status.account) {
    throw new TriageChatNotConnectedError(
      "No Microsoft account is connected. Connect the mailbox in Admin > Email before creating a chat.",
    );
  }
  const id = await lookupUserId(status.account);
  if (!id) {
    throw new TriageChatNotConnectedError(
      `The connected account ${status.account} could not be found in the directory.`,
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
  },
  deps: CreateTriageChatDeps = {},
): Promise<CreateTriageChatResult> {
  const {
    loadDraft = (presetId: string) => loadTriageChatDraft(presetId),
    createGroupChat = graphCreateGroupChat,
    addChatMember = graphAddChatMember,
    postChatMessage = graphPostChatMessage,
    serviceAccountId = defaultServiceAccountId,
  } = deps;

  // Re-resolve server side. The form contributes only a set of person ids to
  // KEEP; it never supplies identities or Entra ids, so a tampered field cannot
  // name an arbitrary person into the chat.
  const draft = await loadDraft(input.presetId);
  if (!draft) throw new Error("This preset has no clinic date to build a chat for.");

  const keep = new Set(input.includePersonIds);
  const selected = draft.resolved.filter((r) => keep.has(r.member.personId));

  const stored = selected.filter((r) => r.source === "stored" && r.userId);
  const directory = selected.filter((r) => r.source === "directory" && r.userId);
  const unresolved = selected.filter((r) => !r.userId);

  if (stored.length === 0 && directory.length === 0) {
    throw new Error("Nobody in this roster can be added to a chat.");
  }

  const ownerId = await serviceAccountId();

  // Seed the create with ids that came from a real sign-in, which cannot be
  // wrong. A create is atomic, so one bad id would fail the chat for everyone.
  // When there are none, promote a single directory-resolved member so the chat
  // is still valid, and add the rest individually as usual.
  const promoted = stored.length === 0 ? directory.slice(0, 1) : [];
  const createMembers = [...stored, ...promoted];
  const incremental = directory.filter((r) => !promoted.includes(r));

  // Claim the week BEFORE calling Graph. The unique constraint is the guard: a
  // double submit loses the insert here rather than creating a second chat.
  let claimed;
  try {
    claimed = await prisma.triageChat.create({
      data: {
        presetId: input.presetId,
        termId: draft.term.id,
        clinicDate: draft.clinicDate,
        topic: input.topic,
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
      topic: input.topic,
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

  const failures: { name: string; reason: string }[] = [];
  const memberRows: Prisma.TriageChatMemberCreateManyInput[] = createMembers.map((r) => ({
    triageChatId: claimed.id,
    personId: r.member.personId,
    personName: r.member.name,
    departmentName: r.member.departmentName,
    addedOk: true,
  }));

  for (const r of incremental) {
    try {
      await addChatMember(chat.chatId, r.userId!);
      memberRows.push({
        triageChatId: claimed.id,
        personId: r.member.personId,
        personName: r.member.name,
        departmentName: r.member.departmentName,
        addedOk: true,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
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
  }

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

  let messagePosted = false;
  try {
    await postChatMessage(chat.chatId, textToTeamsHtml(input.messageBody));
    messagePosted = true;
  } catch (err) {
    // Keep the row. That is the whole point: with graphChatId recorded, a retry
    // posts the message instead of creating a second chat.
    log.error("[triage-chats] opening message failed", errorAttrs(err, { chatId: chat.chatId }));
  }

  await prisma.$transaction([
    prisma.triageChat.update({
      where: { id: claimed.id },
      data: {
        graphChatId: chat.chatId,
        webUrl: chat.webUrl,
        messagePostedAt: messagePosted ? new Date() : null,
      },
    }),
    prisma.triageChatMember.createMany({ data: memberRows }),
  ]);

  await recordAudit({
    actorPersonId: input.actorPersonId,
    action: "triage_chat.create",
    entityType: "TriageChat",
    entityId: claimed.id,
    after: {
      topic: input.topic,
      clinicDate: draft.clinicDateKey,
      membersAdded: memberRows.filter((m) => m.addedOk).length,
      membersFailed: failures.length,
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

/** Post the opening message for a chat that was created without one. */
export async function retryTriageChatMessage(
  triageChatId: string,
  messageBody: string,
  deps: { postChatMessage?: typeof graphPostChatMessage } = {},
): Promise<void> {
  const post = deps.postChatMessage ?? graphPostChatMessage;
  const chat = await prisma.triageChat.findUniqueOrThrow({
    where: { id: triageChatId },
    select: { graphChatId: true, messagePostedAt: true },
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
    await post(chat.graphChatId, textToTeamsHtml(messageBody));
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
