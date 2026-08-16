import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/platform/db";
import { TECH_REQUEST_FIELDS as T, YNHH_TRACKER_FIELDS as Y } from "../../fields";
import { loadSupportHistory, findMergeTarget, type ExistingTicket } from "./load";

const sel = (name: string) => ({ id: `sel${name}`, name, color: "blueLight2" });
const link = (id: string) => [{ id, name: id }];

/** Unique suffix per run so the shared test database does not collide. */
const uid = () => Math.random().toString(36).slice(2, 10);

async function makePerson(name: string, airtableRecordId: string) {
  return prisma.person.create({ data: { name, airtableRecordId } });
}

const techRecord = (id: string, fields: Record<string, unknown>) => ({
  id,
  fields: {
    [T.status]: sel("Resolved"),
    [T.requestType]: sel("Epic Issue"),
    [T.priority]: sel("High"),
    ...fields,
  },
  createdTime: "2026-02-05T23:01:29.000Z",
});

const trackerRecord = (id: string, fields: Record<string, unknown>) => ({
  id,
  fields: {
    [Y.ticketStatus]: [sel("Closed")],
    [Y.dateSubmitted]: "2026-07-09T12:22:00.000Z",
    ...fields,
  },
  createdTime: "2026-07-10T12:20:35.000Z",
});

const load = (input: Parameters<typeof loadSupportHistory>[1], dryRun = false) =>
  loadSupportHistory(prisma, input, { dryRun, skipAttachments: true });

describe("findMergeTarget", () => {
  const base: ExistingTicket = {
    id: "t1",
    serviceRequestNumber: null,
    submittedAt: new Date("2026-07-10T00:00:00Z"),
    requests: [{ personId: "p1" }],
  };
  const when = new Date("2026-07-11T00:00:00Z");

  it("merges a hub ticket that links the same person and has no number yet", () => {
    expect(findMergeTarget([base], "p1", when, new Set())?.id).toBe("t1");
  });

  it("refuses a ticket that already carries a service request number", () => {
    expect(findMergeTarget([{ ...base, serviceRequestNumber: "RITM1" }], "p1", when, new Set())).toBeNull();
  });

  it("refuses a ticket linking a different person", () => {
    expect(findMergeTarget([{ ...base, requests: [{ personId: "p2" }] }], "p1", when, new Set())).toBeNull();
  });

  it("refuses a ticket with no linked Epic request at all", () => {
    expect(findMergeTarget([{ ...base, requests: [] }], "p1", when, new Set())).toBeNull();
  });

  it("refuses a ticket outside the two-week window", () => {
    const far = { ...base, submittedAt: new Date("2026-05-01T00:00:00Z") };
    expect(findMergeTarget([far], "p1", when, new Set())).toBeNull();
  });

  it("refuses to guess when two candidates match equally well", () => {
    expect(findMergeTarget([base, { ...base, id: "t2" }], "p1", when, new Set())).toBeNull();
  });

  it("skips a candidate already claimed earlier in the run", () => {
    expect(findMergeTarget([base], "p1", when, new Set(["t1"]))).toBeNull();
  });
});

describe("loadSupportHistory", () => {
  beforeEach(async () => {
    await prisma.techRequestAttachment.deleteMany();
    await prisma.epicRequest.deleteMany();
    await prisma.techRequest.deleteMany();
    await prisma.ynhhTicket.deleteMany();
  });

  it("imports a tech request with its Airtable number and provenance id", async () => {
    const p = await makePerson(`Requester ${uid()}`, `recP${uid()}`);
    const { report } = await load({
      techRecords: [
        techRecord("recT1", {
          [T.requestId]: 23,
          [T.requester]: link(p.airtableRecordId!),
          [T.description]: "Epic Renewal",
        }),
      ],
      trackerRecords: [],
    });

    expect(report.techRequests.created).toBe(1);
    const saved = await prisma.techRequest.findUnique({ where: { airtableRecordId: "recT1" } });
    expect(saved?.number).toBe(23);
    expect(saved?.subject).toBe("Epic Renewal");
    expect(saved?.status).toBe("CLOSED");
    expect(saved?.requesterId).toBe(p.id);
  });

  it("is idempotent: a second run updates rather than duplicating", async () => {
    const p = await makePerson(`Requester ${uid()}`, `recP${uid()}`);
    const input = {
      techRecords: [
        techRecord("recT1", { [T.requestId]: 23, [T.requester]: link(p.airtableRecordId!) }),
      ],
      trackerRecords: [],
    };
    const first = await load(input);
    const second = await load(input);

    expect(first.report.techRequests.created).toBe(1);
    expect(second.report.techRequests.created).toBe(0);
    expect(second.report.techRequests.updated).toBe(1);
    expect(await prisma.techRequest.count()).toBe(1);
    expect(await prisma.epicRequest.count()).toBe(0);
  });

  it("creates one Epic request per Epic ticket and does not stack them on re-run", async () => {
    const p = await makePerson(`Requester ${uid()}`, `recP${uid()}`);
    const input = {
      techRecords: [
        techRecord("recT1", {
          [T.requestId]: 24,
          [T.requester]: link(p.airtableRecordId!),
          [T.epicIssueType]: sel("Renewal"),
        }),
      ],
      trackerRecords: [],
    };
    await load(input);
    await load(input);

    const epics = await prisma.epicRequest.findMany();
    expect(epics).toHaveLength(1);
    expect(epics[0].kind).toBe("RENEW");
    expect(epics[0].status).toBe("COMPLETED");
    expect(epics[0].personId).toBe(p.id);
  });

  it("groups tech requests sharing an inline RITM into one YNHH ticket and links it", async () => {
    const p = await makePerson(`Requester ${uid()}`, `recP${uid()}`);
    const a = await makePerson(`Assignee ${uid()}`, `recA${uid()}`);
    const { report } = await load({
      techRecords: [
        techRecord("recT1", {
          [T.requestId]: 30,
          [T.requester]: link(p.airtableRecordId!),
          [T.assignedTo]: link(a.airtableRecordId!),
          [T.epicIssueType]: sel("Renewal"),
          [T.ynhhTicketNumber]: "RITM0311472",
        }),
        techRecord("recT2", {
          [T.requestId]: 31,
          [T.requester]: link(p.airtableRecordId!),
          [T.assignedTo]: link(a.airtableRecordId!),
          [T.epicIssueType]: sel("New Account"),
          [T.ynhhTicketNumber]: " RITM0311472 ",
        }),
      ],
      trackerRecords: [],
    });

    expect(report.ynhhTickets.createdFromTickets).toBe(1);
    const tickets = await prisma.ynhhTicket.findMany({ include: { requests: true } });
    expect(tickets).toHaveLength(1);
    expect(tickets[0].serviceRequestNumber).toBe("RITM0311472");
    expect(tickets[0].submittedById).toBe(a.id);
    expect(tickets[0].requests).toHaveLength(2);
  });

  it("merges a tracker row into the hub ticket that already records it", async () => {
    const subject = await makePerson(`Usman Khalid ${uid()}`, `recS${uid()}`);
    const submitterName = `Caprice Culkin ${uid()}`;
    const submitter = await makePerson(submitterName, `recC${uid()}`);
    const existing = await prisma.ynhhTicket.create({
      data: {
        description: "Renew - Individual - submitter",
        status: "OPEN",
        submittedById: submitter.id,
        submittedAt: new Date("2026-07-10T00:00:00Z"),
        requests: {
          create: { personId: subject.id, requestedById: submitter.id, kind: "RENEW" },
        },
      },
    });

    const { report } = await load({
      techRecords: [],
      trackerRecords: [
        trackerRecord("recY1", {
          [Y.briefDescription]: `${subject.name} Renew`,
          [Y.submitter]: sel(submitterName),
          [Y.serviceRequestNumber]: "RITM0344511",
          [Y.dateSubmitted]: "2026-07-10T14:57:00.000Z",
        }),
      ],
    });

    expect(report.ynhhTickets.mergedIntoExisting).toBe(1);
    expect(report.ynhhTickets.createdFromTracker).toBe(0);
    expect(await prisma.ynhhTicket.count()).toBe(1);
    const merged = await prisma.ynhhTicket.findUnique({ where: { id: existing.id } });
    expect(merged?.serviceRequestNumber).toBe("RITM0344511");
    expect(merged?.status).toBe("CLOSED");
  });

  it("creates a new ticket when no hub ticket links that person", async () => {
    const subject = await makePerson(`Iris Becene ${uid()}`, `recS${uid()}`);
    const submitterName = `Caprice Culkin ${uid()}`;
    await makePerson(submitterName, `recC${uid()}`);
    const { report } = await load({
      techRecords: [],
      trackerRecords: [
        trackerRecord("recY1", {
          [Y.briefDescription]: `${subject.name} Renew`,
          [Y.submitter]: sel(submitterName),
          [Y.serviceRequestNumber]: "RITM0344243",
        }),
      ],
    });

    expect(report.ynhhTickets.createdFromTracker).toBe(1);
    expect(report.ynhhTickets.mergedIntoExisting).toBe(0);
    const epics = await prisma.epicRequest.findMany();
    expect(epics).toHaveLength(1);
    expect(epics[0].personId).toBe(subject.id);
    expect(epics[0].kind).toBe("RENEW");
  });

  it("reports a tracker name it cannot resolve instead of guessing a person", async () => {
    const submitterName = `Caprice Culkin ${uid()}`;
    await makePerson(submitterName, `recC${uid()}`);
    const { report } = await load({
      techRecords: [],
      trackerRecords: [
        trackerRecord("recY1", {
          [Y.briefDescription]: "3 PATS people",
          [Y.submitter]: sel(submitterName),
          [Y.serviceRequestNumber]: "RITM0344543",
        }),
      ],
    });

    expect(report.unresolvedTrackerNames).toEqual([{ recordId: "recY1", text: "3 PATS people" }]);
    // The ticket is still recorded; only the person link is withheld.
    expect(report.ynhhTickets.createdFromTracker).toBe(1);
    expect(await prisma.epicRequest.count()).toBe(0);
  });

  it("counts content-free hub tickets without touching them", async () => {
    const submitter = await makePerson(`Caprice Culkin ${uid()}`, `recC${uid()}`);
    await prisma.ynhhTicket.create({
      data: { description: "New - Individual - submitter", submittedById: submitter.id },
    });
    const { report } = await load({ techRecords: [], trackerRecords: [] });

    expect(report.contentFreeExistingTickets).toBe(1);
    expect(await prisma.ynhhTicket.count()).toBe(1);
  });

  it("writes nothing on a dry run but still reports the plan", async () => {
    const p = await makePerson(`Requester ${uid()}`, `recP${uid()}`);
    const { report } = await load(
      {
        techRecords: [
          techRecord("recT1", {
            [T.requestId]: 40,
            [T.requester]: link(p.airtableRecordId!),
            [T.epicIssueType]: sel("Renewal"),
          }),
        ],
        trackerRecords: [],
      },
      true,
    );

    expect(report.techRequests.created).toBe(1);
    expect(report.epicRequests.created).toBe(1);
    expect(await prisma.techRequest.count()).toBe(0);
    expect(await prisma.epicRequest.count()).toBe(0);
  });

  it("reports the next free ticket number so the sequence can be moved past the import", async () => {
    const p = await makePerson(`Requester ${uid()}`, `recP${uid()}`);
    const { report } = await load({
      techRecords: [
        techRecord("recT1", { [T.requestId]: 151, [T.requester]: link(p.airtableRecordId!) }),
        techRecord("recT2", { [T.requestId]: 23, [T.requester]: link(p.airtableRecordId!) }),
      ],
      trackerRecords: [],
    });
    expect(report.nextTechRequestNumber).toBe(152);
  });

  it("skips a row whose requester is not in the hub rather than failing the run", async () => {
    const { report } = await load({
      techRecords: [techRecord("recT1", { [T.requestId]: 50, [T.requester]: link("recGhost") })],
      trackerRecords: [],
    });
    expect(report.techRequests.created).toBe(0);
    expect(report.skipped).toContainEqual({
      source: "Tech Requests",
      recordId: "recT1",
      reason: "requester does not resolve to a Person",
    });
  });

  it("queues no email, Teams message or notification", async () => {
    const p = await makePerson(`Requester ${uid()}`, `recP${uid()}`);
    const before = await Promise.all([
      prisma.emailLog.count(),
      prisma.teamsMessage.count(),
      prisma.notification.count(),
    ]);
    await load({
      techRecords: [
        techRecord("recT1", {
          [T.requestId]: 60,
          [T.requester]: link(p.airtableRecordId!),
          [T.epicIssueType]: sel("New Account"),
          [T.ynhhTicketNumber]: "RITM0311999",
        }),
      ],
      trackerRecords: [],
    });
    const after = await Promise.all([
      prisma.emailLog.count(),
      prisma.teamsMessage.count(),
      prisma.notification.count(),
    ]);
    expect(after).toEqual(before);
  });
});
