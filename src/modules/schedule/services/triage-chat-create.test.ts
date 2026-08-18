import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  createTriageChat,
  retryTriageChatMessage,
  NOT_SELECTED_REASON,
  TriageChatConflictError,
} from "./triage-chat-create";
import type { TriageChatDraft } from "./triage-chat-draft";

beforeEach(resetDb);

const CLINIC_DATE = new Date("2026-05-30T12:00:00Z");

async function seedDraftFixtures() {
  const term = await prisma.term.create({
    data: {
      code: "SU26",
      name: "Summer 2026",
      startDate: new Date("2026-05-01T12:00:00Z"),
      endDate: new Date("2026-08-01T12:00:00Z"),
      status: "ACTIVE",
      clinicDates: [CLINIC_DATE],
    },
  });
  const dept = await prisma.department.create({ data: { code: "BVHD", name: "Behavioral Health" } });
  const stored = await prisma.person.create({
    data: { name: "Goeun Lee", netId: "gl1", entraObjectId: "oid-stored" },
  });
  const looked = await prisma.person.create({ data: { name: "Never Signed In", netId: "ns1" } });
  const preset = await prisma.triageChatPreset.create({
    data: { name: "Ancillary", nameTemplate: "{{clinicDateShort}} Ancillary", messageTemplate: "hi" },
  });
  return { term, dept, stored, looked, preset };
}

function draftFor(fixtures: Awaited<ReturnType<typeof seedDraftFixtures>>): TriageChatDraft {
  const member = (id: string, name: string, entraObjectId: string | null) => ({
    personId: id,
    name,
    netId: "n",
    contactEmail: null,
    entraObjectId,
    departmentName: "Behavioral Health",
  });
  const storedMember = member(fixtures.stored.id, "Goeun Lee", "oid-stored");
  const lookedMember = member(fixtures.looked.id, "Never Signed In", null);
  return {
    preset: { id: fixtures.preset.id, name: "Ancillary", nameTemplate: "", messageTemplate: "" },
    term: { id: fixtures.term.id, name: "Summer 2026" },
    clinicDate: CLINIC_DATE,
    clinicDateKey: "2026-05-30",
    topic: "05.30.26 Ancillary",
    messageBody: "Hi everyone",
    roster: {
      members: [storedMember, lookedMember],
      rosterBlock: "- Behavioral Health: Goeun Lee, Never Signed In",
      sessionCoordinators: [],
      clinicalAdvisors: [],
      emptyDepartments: [],
      emptyAlwaysIncludeDepartments: [],
    },
    resolved: [
      { member: storedMember, userId: "oid-stored", source: "stored" },
      { member: lookedMember, userId: "oid-looked", source: "directory" },
    ],
    warnings: [],
    existingChat: null,
  };
}

function graphStub(over: Partial<Parameters<typeof createTriageChat>[1]> = {}) {
  return {
    createGroupChat: vi.fn(async () => ({ chatId: "chat-1", webUrl: "https://teams/1" })),
    addChatMember: vi.fn(async () => {}),
    postChatMessage: vi.fn(async () => {}),
    serviceAccountId: async () => "oid-service",
    ...over,
  };
}

describe("createTriageChat", () => {
  it("creates with the stored ids and adds the directory-resolved ones after", async () => {
    const fixtures = await seedDraftFixtures();
    const draft = draftFor(fixtures);
    const graph = graphStub();

    const result = await createTriageChat(
      {
        presetId: fixtures.preset.id,
        actorPersonId: fixtures.stored.id,
        topic: draft.topic,
        messageBody: draft.messageBody,
        includePersonIds: [fixtures.stored.id, fixtures.looked.id],
      },
      { ...graph, loadDraft: async () => draft },
    );

    expect(graph.createGroupChat).toHaveBeenCalledWith({
      topic: "05.30.26 Ancillary",
      memberIds: ["oid-service", "oid-stored"],
    });
    expect(graph.addChatMember).toHaveBeenCalledWith("chat-1", "oid-looked");
    expect(graph.postChatMessage).toHaveBeenCalledTimes(1);
    expect(result.messagePosted).toBe(true);
    expect(result.failures).toEqual([]);

    const saved = await prisma.triageChat.findFirstOrThrow({ include: { members: true } });
    expect(saved.graphChatId).toBe("chat-1");
    expect(saved.messagePostedAt).not.toBeNull();
    expect(saved.members).toHaveLength(2);
    expect(saved.members.every((m) => m.addedOk)).toBe(true);
  });

  it("records a chat with no posted message when the message fails", async () => {
    const fixtures = await seedDraftFixtures();
    const draft = draftFor(fixtures);
    const graph = graphStub({
      postChatMessage: vi.fn(async () => {
        throw new Error("Graph post chat message failed: 502");
      }),
    });

    const result = await createTriageChat(
      {
        presetId: fixtures.preset.id,
        actorPersonId: fixtures.stored.id,
        topic: draft.topic,
        messageBody: draft.messageBody,
        includePersonIds: [fixtures.stored.id],
      },
      { ...graph, loadDraft: async () => draft },
    );

    expect(result.messagePosted).toBe(false);
    const saved = await prisma.triageChat.findFirstOrThrow();
    expect(saved.graphChatId).toBe("chat-1");
    expect(saved.messagePostedAt).toBeNull();
  });

  it("records a failed member add without losing the chat", async () => {
    const fixtures = await seedDraftFixtures();
    const draft = draftFor(fixtures);
    const graph = graphStub({
      addChatMember: vi.fn(async () => {
        throw new Error("Graph add chat member failed: 403 -- forbidden");
      }),
    });

    const result = await createTriageChat(
      {
        presetId: fixtures.preset.id,
        actorPersonId: fixtures.stored.id,
        topic: draft.topic,
        messageBody: draft.messageBody,
        includePersonIds: [fixtures.stored.id, fixtures.looked.id],
      },
      { ...graph, loadDraft: async () => draft },
    );

    expect(result.failures).toEqual([
      { name: "Never Signed In", reason: expect.stringContaining("403") },
    ]);
    const saved = await prisma.triageChat.findFirstOrThrow({ include: { members: true } });
    const failed = saved.members.find((m) => m.personName === "Never Signed In");
    expect(failed?.addedOk).toBe(false);
  });

  it("refuses a second chat for the same preset and clinic date", async () => {
    const fixtures = await seedDraftFixtures();
    const draft = draftFor(fixtures);
    const graph = graphStub();
    const input = {
      presetId: fixtures.preset.id,
      actorPersonId: fixtures.stored.id,
      topic: draft.topic,
      messageBody: draft.messageBody,
      includePersonIds: [fixtures.stored.id],
    };

    await createTriageChat(input, { ...graph, loadDraft: async () => draft });
    await expect(
      createTriageChat(input, { ...graph, loadDraft: async () => draft }),
    ).rejects.toBeInstanceOf(TriageChatConflictError);
    expect(await prisma.triageChat.count()).toBe(1);
    expect(graph.createGroupChat).toHaveBeenCalledTimes(1);
  });

  it("ignores a person id that is not in the resolved roster", async () => {
    const fixtures = await seedDraftFixtures();
    const draft = draftFor(fixtures);
    const graph = graphStub();
    const outsider = await prisma.person.create({
      data: { name: "Outsider", netId: "out1", entraObjectId: "oid-outsider" },
    });

    await createTriageChat(
      {
        presetId: fixtures.preset.id,
        actorPersonId: fixtures.stored.id,
        topic: draft.topic,
        messageBody: draft.messageBody,
        includePersonIds: [fixtures.stored.id, outsider.id],
      },
      { ...graph, loadDraft: async () => draft },
    );

    expect(graph.createGroupChat).toHaveBeenCalledWith({
      topic: "05.30.26 Ancillary",
      memberIds: ["oid-service", "oid-stored"],
    });
  });

  it("leaves nothing recorded when the chat itself cannot be created", async () => {
    const fixtures = await seedDraftFixtures();
    const draft = draftFor(fixtures);
    const graph = graphStub({
      createGroupChat: vi.fn(async () => {
        throw new Error("Graph create group chat failed: 400");
      }),
    });

    await expect(
      createTriageChat(
        {
          presetId: fixtures.preset.id,
          actorPersonId: fixtures.stored.id,
          topic: draft.topic,
          messageBody: draft.messageBody,
          includePersonIds: [fixtures.stored.id],
        },
        { ...graph, loadDraft: async () => draft },
      ),
    ).rejects.toThrow(/400/);
    expect(await prisma.triageChat.count()).toBe(0);
  });

  it("writes an audit entry", async () => {
    const fixtures = await seedDraftFixtures();
    const draft = draftFor(fixtures);
    await createTriageChat(
      {
        presetId: fixtures.preset.id,
        actorPersonId: fixtures.stored.id,
        topic: draft.topic,
        messageBody: draft.messageBody,
        includePersonIds: [fixtures.stored.id],
      },
      { ...graphStub(), loadDraft: async () => draft },
    );
    const audit = await prisma.auditLog.findFirstOrThrow();
    expect(audit.action).toBe("triage_chat.create");
    expect(audit.entityType).toBe("TriageChat");
  });

  it("promotes one directory-resolved member into the create when nobody has a stored id", async () => {
    const fixtures = await seedDraftFixtures();
    const draft = draftFor(fixtures);
    // Nobody has signed into the Hub yet, the normal state early in a term, so
    // every member has to come from a directory lookup.
    draft.resolved = [
      { member: draft.roster.members[0], userId: "oid-a", source: "directory" },
      { member: draft.roster.members[1], userId: "oid-b", source: "directory" },
    ];
    const graph = graphStub();

    await createTriageChat(
      {
        presetId: fixtures.preset.id,
        actorPersonId: fixtures.stored.id,
        topic: draft.topic,
        messageBody: draft.messageBody,
        includePersonIds: draft.roster.members.map((m) => m.personId),
      },
      { ...graph, loadDraft: async () => draft },
    );

    // Exactly one is promoted into the atomic create: promoting none would fail
    // it (Graph needs a member), promoting both would give up the per-person
    // failure isolation the incremental path exists for. The promoted member
    // must NOT also be added incrementally, which is what the identity-based
    // exclusion guarantees.
    expect(graph.createGroupChat).toHaveBeenCalledWith({
      topic: draft.topic,
      memberIds: ["oid-service", "oid-a"],
    });
    expect(graph.addChatMember).toHaveBeenCalledTimes(1);
    expect(graph.addChatMember).toHaveBeenCalledWith("chat-1", "oid-b");

    const saved = await prisma.triageChat.findFirstOrThrow({ include: { members: true } });
    expect(saved.members).toHaveLength(2);
    expect(saved.members.every((m) => m.addedOk)).toBe(true);
  });

  it("records and reports a member the directory could not resolve, even though the form cannot submit them", async () => {
    const fixtures = await seedDraftFixtures();
    const draft = draftFor(fixtures);
    // The review form disables this person's checkbox, so they are absent from
    // includePersonIds below. They are still on shift and still need adding by
    // hand, so they must appear in the record and in the reported failures.
    draft.resolved = [
      { member: draft.roster.members[0], userId: "oid-stored", source: "stored" },
      {
        member: draft.roster.members[1],
        userId: null,
        source: "unresolved",
        reason: "Not found in the Microsoft directory.",
      },
    ];
    const graph = graphStub();

    const result = await createTriageChat(
      {
        presetId: fixtures.preset.id,
        actorPersonId: fixtures.stored.id,
        topic: draft.topic,
        messageBody: draft.messageBody,
        // Only the resolvable member; the other one's checkbox was disabled.
        includePersonIds: [draft.roster.members[0].personId],
      },
      { ...graph, loadDraft: async () => draft },
    );

    expect(result.failures).toEqual([
      { name: draft.roster.members[1].name, reason: "Not found in the Microsoft directory." },
    ]);

    const saved = await prisma.triageChat.findFirstOrThrow({ include: { members: true } });
    const dropped = saved.members.filter((m) => m.personName === draft.roster.members[1].name);
    // Exactly one row. An unresolvable person is also absent from the keep-set,
    // so the not-selected record must not claim them a second time with a reason
    // that does not explain their absence.
    expect(dropped).toHaveLength(1);
    expect(dropped[0].addedOk).toBe(false);
    expect(dropped[0].error).toBe("Not found in the Microsoft directory.");
  });

  it("records the chat id the moment Graph returns it, before the member loop", async () => {
    const fixtures = await seedDraftFixtures();
    const draft = draftFor(fixtures);
    // The row must already name the chat while the adds are still running: on a
    // twenty-person roster this loop is where the function gets killed, and a
    // row that learns the chat id only at the end leaves a real Teams chat
    // nobody can reach behind a claim that locks the week out of the UI.
    const recordedDuringLoop: { graphChatId: string; webUrl: string }[] = [];
    const graph = graphStub({
      addChatMember: vi.fn(async () => {
        recordedDuringLoop.push(
          await prisma.triageChat.findFirstOrThrow({
            select: { graphChatId: true, webUrl: true },
          }),
        );
      }),
    });

    await createTriageChat(
      {
        presetId: fixtures.preset.id,
        actorPersonId: fixtures.stored.id,
        topic: draft.topic,
        messageBody: draft.messageBody,
        includePersonIds: [fixtures.stored.id, fixtures.looked.id],
      },
      { ...graph, loadDraft: async () => draft },
    );

    expect(graph.addChatMember).toHaveBeenCalledTimes(1);
    expect(recordedDuringLoop).toEqual([{ graphChatId: "chat-1", webUrl: "https://teams/1" }]);
  });

  it("records the chat id before the opening message is posted", async () => {
    const fixtures = await seedDraftFixtures();
    const draft = draftFor(fixtures);
    const recordedBeforePost: string[] = [];
    const graph = graphStub({
      postChatMessage: vi.fn(async () => {
        const row = await prisma.triageChat.findFirstOrThrow({ select: { graphChatId: true } });
        recordedBeforePost.push(row.graphChatId);
        throw new Error("Graph post chat message failed: 502");
      }),
    });

    const result = await createTriageChat(
      {
        presetId: fixtures.preset.id,
        actorPersonId: fixtures.stored.id,
        topic: draft.topic,
        messageBody: draft.messageBody,
        includePersonIds: [fixtures.stored.id],
      },
      { ...graph, loadDraft: async () => draft },
    );

    expect(result.messagePosted).toBe(false);
    expect(recordedBeforePost).toEqual(["chat-1"]);
    const saved = await prisma.triageChat.findFirstOrThrow();
    expect(saved.graphChatId).toBe("chat-1");
    expect(saved.messagePostedAt).toBeNull();
  });

  it("records a resolvable member who was not kept, without reporting them as a failure", async () => {
    const fixtures = await seedDraftFixtures();
    const draft = draftFor(fixtures);
    const graph = graphStub();

    const result = await createTriageChat(
      {
        presetId: fixtures.preset.id,
        actorPersonId: fixtures.stored.id,
        topic: draft.topic,
        messageBody: draft.messageBody,
        // The ED unticked the second member, or they came onto the schedule
        // after the review screen was opened. Both look like this.
        includePersonIds: [fixtures.stored.id],
      },
      { ...graph, loadDraft: async () => draft },
    );

    // Not a failure: nagging an ED to hand-add somebody they deliberately
    // unticked is wrong, and the alert on the confirmation page is a call to act.
    expect(result.failures).toEqual([]);
    expect(graph.addChatMember).not.toHaveBeenCalled();

    const saved = await prisma.triageChat.findFirstOrThrow({ include: { members: true } });
    expect(saved.members).toHaveLength(2);
    const unkept = saved.members.find((m) => m.personName === "Never Signed In");
    expect(unkept?.addedOk).toBe(false);
    expect(unkept?.error).toBe(NOT_SELECTED_REASON);
  });

  it("refuses an empty chat name", async () => {
    const fixtures = await seedDraftFixtures();
    const draft = draftFor(fixtures);
    const graph = graphStub();

    await expect(
      createTriageChat(
        {
          presetId: fixtures.preset.id,
          actorPersonId: fixtures.stored.id,
          // Whitespace only. `required` on the form is client-only, and an
          // unnamed Teams chat cannot be renamed afterwards.
          topic: "   ",
          messageBody: draft.messageBody,
          includePersonIds: [fixtures.stored.id],
        },
        { ...graph, loadDraft: async () => draft },
      ),
    ).rejects.toThrow(/chat name cannot be empty/i);

    expect(graph.createGroupChat).not.toHaveBeenCalled();
    expect(await prisma.triageChat.count()).toBe(0);
  });

  it("refuses an empty opening message", async () => {
    const fixtures = await seedDraftFixtures();
    const draft = draftFor(fixtures);
    const graph = graphStub();

    await expect(
      createTriageChat(
        {
          presetId: fixtures.preset.id,
          actorPersonId: fixtures.stored.id,
          topic: draft.topic,
          messageBody: "\n  \n",
          includePersonIds: [fixtures.stored.id],
        },
        { ...graph, loadDraft: async () => draft },
      ),
    ).rejects.toThrow(/opening message cannot be empty/i);

    expect(graph.createGroupChat).not.toHaveBeenCalled();
    expect(await prisma.triageChat.count()).toBe(0);
  });

  it("stores and sends the trimmed topic and message", async () => {
    const fixtures = await seedDraftFixtures();
    const draft = draftFor(fixtures);
    const graph = graphStub();

    await createTriageChat(
      {
        presetId: fixtures.preset.id,
        actorPersonId: fixtures.stored.id,
        topic: "  05.30.26 Ancillary  ",
        messageBody: "  Hi everyone\n",
        includePersonIds: [fixtures.stored.id],
      },
      { ...graph, loadDraft: async () => draft },
    );

    expect(graph.createGroupChat).toHaveBeenCalledWith({
      topic: "05.30.26 Ancillary",
      memberIds: ["oid-service", "oid-stored"],
    });
    const saved = await prisma.triageChat.findFirstOrThrow();
    expect(saved.topic).toBe("05.30.26 Ancillary");
    expect(saved.messageBody).toBe("Hi everyone");
  });

  it("refuses a confirm whose clinic week rolled over while the page was open", async () => {
    const fixtures = await seedDraftFixtures();
    const draft = draftFor(fixtures);
    const graph = graphStub();

    await expect(
      createTriageChat(
        {
          presetId: fixtures.preset.id,
          actorPersonId: fixtures.stored.id,
          topic: draft.topic,
          messageBody: draft.messageBody,
          includePersonIds: [fixtures.stored.id],
          // Opened on the previous clinic week. The draft reloaded here is for
          // 2026-05-30, so the topic, the message, and the ticked boxes in hand
          // all describe a different Saturday than the roster now does.
          expectedClinicDateKey: "2026-05-23",
        },
        { ...graph, loadDraft: async () => draft },
      ),
    ).rejects.toThrow(/clinic week changed/i);

    expect(graph.createGroupChat).not.toHaveBeenCalled();
    expect(await prisma.triageChat.count()).toBe(0);
  });

  it("creates when the clinic week the page was built for still matches", async () => {
    const fixtures = await seedDraftFixtures();
    const draft = draftFor(fixtures);
    const graph = graphStub();

    await createTriageChat(
      {
        presetId: fixtures.preset.id,
        actorPersonId: fixtures.stored.id,
        topic: draft.topic,
        messageBody: draft.messageBody,
        includePersonIds: [fixtures.stored.id],
        expectedClinicDateKey: "2026-05-30",
      },
      { ...graph, loadDraft: async () => draft },
    );

    expect(graph.createGroupChat).toHaveBeenCalledTimes(1);
    expect(await prisma.triageChat.count()).toBe(1);
  });
});

describe("retryTriageChatMessage", () => {
  async function seedChat(
    over: {
      graphChatId?: string;
      messagePostedAt?: Date | null;
      messageBody?: string;
    } = {},
  ) {
    const fixtures = await seedDraftFixtures();
    return prisma.triageChat.create({
      data: {
        presetId: fixtures.preset.id,
        termId: fixtures.term.id,
        clinicDate: CLINIC_DATE,
        topic: "05.30.26 Ancillary",
        messageBody: over.messageBody ?? "Hi everyone",
        graphChatId: over.graphChatId ?? "chat-1",
        webUrl: "https://teams/1",
        messagePostedAt: over.messagePostedAt ?? null,
      },
      select: { id: true },
    });
  }

  it("posts the message and records when it went", async () => {
    const chat = await seedChat();
    const postChatMessage = vi.fn(async (_chatId: string, _bodyHtml: string) => {});
    await retryTriageChatMessage(chat.id, { postChatMessage });

    expect(postChatMessage).toHaveBeenCalledTimes(1);
    expect(postChatMessage.mock.calls[0][0]).toBe("chat-1");
    const saved = await prisma.triageChat.findUniqueOrThrow({ where: { id: chat.id } });
    expect(saved.messagePostedAt).not.toBeNull();
  });

  it("does not post again once the message has been posted", async () => {
    const chat = await seedChat({ messagePostedAt: new Date("2026-05-28T10:00:00Z") });
    const postChatMessage = vi.fn(async () => {});
    await retryTriageChatMessage(chat.id, { postChatMessage });
    expect(postChatMessage).not.toHaveBeenCalled();
  });

  it("posts only once when two retries race", async () => {
    const chat = await seedChat();
    const postChatMessage = vi.fn(async () => {});
    // Both callers read messagePostedAt as null before either writes. A plain
    // read-then-write guard sends the opening message to twenty people twice.
    await Promise.all([
      retryTriageChatMessage(chat.id, { postChatMessage }),
      retryTriageChatMessage(chat.id, { postChatMessage }),
    ]);
    expect(postChatMessage).toHaveBeenCalledTimes(1);
  });

  it("releases the claim when the post fails, so a later retry can try again", async () => {
    const chat = await seedChat();
    const failing = vi.fn(async () => {
      throw new Error("Graph post chat message failed: 502");
    });
    await expect(retryTriageChatMessage(chat.id, { postChatMessage: failing }))
      .rejects.toThrow(/502/);

    const afterFailure = await prisma.triageChat.findUniqueOrThrow({ where: { id: chat.id } });
    expect(afterFailure.messagePostedAt).toBeNull();

    const succeeding = vi.fn(async () => {});
    await retryTriageChatMessage(chat.id, { postChatMessage: succeeding });
    expect(succeeding).toHaveBeenCalledTimes(1);
  });

  it("refuses a chat row that has no Graph chat id recorded", async () => {
    const chat = await seedChat({ graphChatId: "" });
    const postChatMessage = vi.fn(async () => {});
    await expect(retryTriageChatMessage(chat.id, { postChatMessage }))
      .rejects.toThrow(/no Microsoft Teams chat id/i);
    expect(postChatMessage).not.toHaveBeenCalled();
  });

  it("posts the message that was stored, not a re-render of the template", async () => {
    const chat = await seedChat({ messageBody: "The exact text the ED approved" });
    const postChatMessage = vi.fn(async (_chatId: string, _bodyHtml: string) => {});
    await retryTriageChatMessage(chat.id, { postChatMessage });
    expect(postChatMessage.mock.calls[0][1]).toContain("The exact text the ED approved");
  });
});
