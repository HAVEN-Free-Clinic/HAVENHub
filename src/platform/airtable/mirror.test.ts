import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { ALL_PEOPLE_FIELDS } from "./fields";
import { drainOutbox, type AirtableWriter, type MirrorTarget } from "./mirror";

const BASE_ID = "appTestBase1234567";
const TABLE_ID = "tblTestTable123456";

/** Fake writer that succeeds by default. */
function fakeWriter(): AirtableWriter {
  return {
    patchRecord: vi.fn().mockResolvedValue({}),
    createRecord: vi.fn().mockResolvedValue({ id: "recNew" }),
  };
}

const enabledTarget: MirrorTarget = {
  enabled: true,
  baseId: BASE_ID,
  peopleTableId: TABLE_ID,
};

const disabledTarget: MirrorTarget = {
  enabled: false,
  baseId: BASE_ID,
  peopleTableId: TABLE_ID,
};

/** Create a person and return it. */
async function createPerson(overrides: { name?: string } = {}) {
  return prisma.person.create({
    data: { name: overrides.name ?? "Jane Doe" },
  });
}

/** Create a PENDING outbox row for a person. */
async function createOutboxRow(personId: string) {
  return prisma.outbox.create({
    data: {
      entityType: "Person",
      entityId: personId,
      operation: "upsert",
      changedFields: ["name"],
      status: "PENDING",
    },
  });
}

/** Create a MirrorRecord mapping for a person. */
async function createMapping(personId: string, recordId = "recExisting") {
  return prisma.mirrorRecord.create({
    data: {
      entityType: "Person",
      entityId: personId,
      baseId: BASE_ID,
      recordId,
    },
  });
}

describe("drainOutbox", () => {
  beforeEach(resetDb);

  it("patches an existing mapping and marks the row SENT with processedAt set", async () => {
    const person = await createPerson();
    await createMapping(person.id, "recExisting");
    const row = await createOutboxRow(person.id);
    const writer = fakeWriter();

    const result = await drainOutbox(writer, enabledTarget);

    expect(result).toBe(1);
    expect(writer.patchRecord).toHaveBeenCalledOnce();
    expect(writer.patchRecord).toHaveBeenCalledWith(
      BASE_ID,
      TABLE_ID,
      "recExisting",
      expect.objectContaining({ [ALL_PEOPLE_FIELDS.name]: expect.any(String) })
    );
    expect(writer.createRecord).not.toHaveBeenCalled();

    const updatedRow = await prisma.outbox.findUniqueOrThrow({ where: { id: row.id } });
    expect(updatedRow.status).toBe("SENT");
    expect(updatedRow.processedAt).not.toBeNull();
  });

  it("creates a record when no mapping exists and stores the MirrorRecord", async () => {
    const person = await createPerson();
    const row = await createOutboxRow(person.id);
    const writer = fakeWriter();

    const result = await drainOutbox(writer, enabledTarget);

    expect(result).toBe(1);
    expect(writer.createRecord).toHaveBeenCalledOnce();
    expect(writer.patchRecord).not.toHaveBeenCalled();

    const mapping = await prisma.mirrorRecord.findUnique({
      where: {
        entityType_entityId_baseId: {
          entityType: "Person",
          entityId: person.id,
          baseId: BASE_ID,
        },
      },
    });
    expect(mapping).not.toBeNull();
    expect(mapping!.recordId).toBe("recNew");

    const updatedRow = await prisma.outbox.findUniqueOrThrow({ where: { id: row.id } });
    expect(updatedRow.status).toBe("SENT");
  });

  it("increments attempts and stores lastError on writer failure; flips to FAILED after MAX_ATTEMPTS", async () => {
    const MAX_ATTEMPTS = 8;
    const person = await createPerson();

    const throwingWriter: AirtableWriter = {
      patchRecord: vi.fn().mockRejectedValue(new Error("network error")),
      createRecord: vi.fn().mockRejectedValue(new Error("network error")),
    };

    // First call: attempts should become 1, status still PENDING
    await createOutboxRow(person.id);
    await drainOutbox(throwingWriter, enabledTarget);

    let row = await prisma.outbox.findFirstOrThrow({ where: { entityId: person.id } });
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain("network error");
    expect(row.status).toBe("PENDING");

    // Drain 7 more times (total 8 attempts) to flip to FAILED
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      await drainOutbox(throwingWriter, enabledTarget);
    }

    row = await prisma.outbox.findFirstOrThrow({ where: { entityId: person.id } });
    expect(row.attempts).toBe(MAX_ATTEMPTS);
    expect(row.status).toBe("FAILED");
  });

  it("marks the row FAILED with 'entity no longer exists' when the person was deleted", async () => {
    const person = await createPerson();
    const row = await createOutboxRow(person.id);

    // Delete the person before draining
    await prisma.person.delete({ where: { id: person.id } });

    const writer = fakeWriter();
    await drainOutbox(writer, enabledTarget);

    const updatedRow = await prisma.outbox.findUniqueOrThrow({ where: { id: row.id } });
    expect(updatedRow.status).toBe("FAILED");
    expect(updatedRow.lastError).toContain("entity no longer exists");
    expect(writer.patchRecord).not.toHaveBeenCalled();
    expect(writer.createRecord).not.toHaveBeenCalled();
  });

  it("returns 0 and never calls the writer when target.enabled is false", async () => {
    const person = await createPerson();
    await createOutboxRow(person.id);
    const writer = fakeWriter();

    const result = await drainOutbox(writer, disabledTarget);

    expect(result).toBe(0);
    expect(writer.patchRecord).not.toHaveBeenCalled();
    expect(writer.createRecord).not.toHaveBeenCalled();

    const rows = await prisma.outbox.findMany({ where: { entityId: person.id } });
    expect(rows.every((r) => r.status === "PENDING")).toBe(true);
  });
});
