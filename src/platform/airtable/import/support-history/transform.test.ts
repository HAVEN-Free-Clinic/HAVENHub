import { describe, it, expect } from "vitest";
import { TECH_REQUEST_FIELDS as T, YNHH_TRACKER_FIELDS as Y } from "../../fields";
import {
  transformTechRequests,
  transformTrackerTickets,
  synthesizeSubject,
  serviceRequestKey,
  resolveTrackerPersonName,
  inferTrackerKind,
  epicIntakeNote,
} from "./transform";

/** Airtable returns singleSelect cells as {id,name,color}; tests use the same shape. */
const sel = (name: string) => ({ id: `sel${name}`, name, color: "blueLight2" });
const link = (id: string, name = id) => [{ id, name }];

const techRecord = (fields: Record<string, unknown>, id = "recTech1") => ({
  id,
  fields: {
    [T.requestId]: 23,
    [T.requester]: link("recPerson1", "Selena Reyes-Flores"),
    [T.status]: sel("Resolved"),
    [T.requestType]: sel("Epic Issue"),
    [T.priority]: sel("High"),
    ...fields,
  },
  createdTime: "2026-02-05T23:01:29.000Z",
});

describe("synthesizeSubject", () => {
  it("uses the first line of the description, trimmed", () => {
    expect(synthesizeSubject("Epic Renewal\nsecond line", "Epic Issue: Renewal")).toBe("Epic Renewal");
  });

  it("truncates a long first line on a word boundary and marks the cut", () => {
    const long =
      "Hi! One of the new RHD directors we are recruiting is going to be coming in this Saturday to serve as SCTM";
    const subject = synthesizeSubject(long, "Epic Issue: New Account");
    expect(subject.length).toBeLessThanOrEqual(80);
    // Cut on whitespace, not mid-word.
    expect(subject).toBe("Hi! One of the new RHD directors we are recruiting is going to be coming in...");
  });

  it("falls back to the supplied Airtable wording when there is no description", () => {
    expect(synthesizeSubject(null, "Epic Issue: New Account")).toBe("Epic Issue: New Account");
    expect(synthesizeSubject("   ", "Epic Issue: Renewal")).toBe("Epic Issue: Renewal");
    expect(synthesizeSubject(null, "DUO Multi-Factor Authentication")).toBe(
      "DUO Multi-Factor Authentication",
    );
  });

  it("builds the fallback subject from the Airtable select names", () => {
    const [epic] = transformTechRequests([
      techRecord({ [T.requestType]: sel("Epic Issue"), [T.epicIssueType]: sel("New Account") }),
    ]).rows;
    expect(epic.subject).toBe("Epic Issue: New Account");

    const [duo] = transformTechRequests([
      techRecord({ [T.requestType]: sel("DUO Multi-Factor Authentication") }),
    ]).rows;
    expect(duo.subject).toBe("DUO Multi-Factor Authentication");
  });
});

describe("transformTechRequests", () => {
  it("maps category, Epic subtype and priority from the Airtable selects", () => {
    const [row] = transformTechRequests([
      techRecord({ [T.epicIssueType]: sel("New Account"), [T.description]: "needs an account" }),
    ]).rows;
    expect(row.category).toBe("EPIC");
    expect(row.epicSubtype).toBe("NEW");
    expect(row.priority).toBe("HIGH");
  });

  it.each([
    ["Epic Issue", "EPIC"],
    ["DUO Multi-Factor Authentication", "DUO_MFA"],
    ["General IT Issue", "GENERAL_IT"],
    ["Teams Access", "TEAMS"],
    ["Other", "OTHER"],
  ])("maps request type %s to category %s", (airtable, expected) => {
    const [row] = transformTechRequests([techRecord({ [T.requestType]: sel(airtable) })]).rows;
    expect(row.category).toBe(expected);
  });

  it.each([
    ["Renewal", "RENEW"],
    ["Modification", "MODIFY"],
    ["New Account", "NEW"],
  ])("maps Epic issue type %s to kind %s", (airtable, expected) => {
    const [row] = transformTechRequests([techRecord({ [T.epicIssueType]: sel(airtable) })]).rows;
    expect(row.epicSubtype).toBe(expected);
  });

  it("lands every terminal Airtable status as CLOSED", () => {
    for (const status of ["Resolved", "Sent Activation Instructions", "Sent Renewal Instructions"]) {
      const [row] = transformTechRequests([techRecord({ [T.status]: sel(status) })]).rows;
      expect(row.status).toBe("CLOSED");
    }
  });

  it.each([
    ["Submitted", "SUBMITTED"],
    ["Awaiting Your Action", "AWAITING_REQUESTER"],
    ["Request Sent to YNHH", "AWAITING_YNHH"],
    ["YNHH Assigned Ticket", "AWAITING_YNHH"],
    ["In Progress", "IN_PROGRESS"],
    ["Unable to Reach", "CLOSED"],
  ])("maps open status %s to %s", (airtable, expected) => {
    const [row] = transformTechRequests([techRecord({ [T.status]: sel(airtable) })]).rows;
    expect(row.status).toBe(expected);
  });

  it("preserves the original Airtable status in the resolution so the distinction survives", () => {
    const [row] = transformTechRequests([
      techRecord({
        [T.status]: sel("Sent Activation Instructions"),
        [T.resolutionDetails]: "Account is live",
      }),
    ]).rows;
    expect(row.resolution).toContain("Account is live");
    expect(row.resolution).toContain("Sent Activation Instructions");
  });

  it("still records the original status when Airtable left the resolution empty", () => {
    const [row] = transformTechRequests([
      techRecord({ [T.status]: sel("Sent Renewal Instructions") }),
    ]).rows;
    expect(row.resolution).toContain("Sent Renewal Instructions");
  });

  it("leaves an open ticket unresolved rather than writing a resolution it does not have", () => {
    const [row] = transformTechRequests([techRecord({ [T.status]: sel("Submitted") })]).rows;
    expect(row.status).toBe("SUBMITTED");
    expect(row.resolution).toBeNull();
  });

  it("keeps real resolution text on an open ticket, without the status line", () => {
    const [row] = transformTechRequests([
      techRecord({
        [T.status]: sel("Awaiting Your Action"),
        [T.resolutionDetails]: "Waiting on the requester to confirm",
      }),
    ]).rows;
    expect(row.resolution).toBe("Waiting on the requester to confirm");
  });

  it("appends the modification description to the body when present", () => {
    const [row] = transformTechRequests([
      techRecord({
        [T.description]: "Please change my context",
        [T.modificationDescription]: "Add PATS",
      }),
    ]).rows;
    expect(row.description).toContain("Please change my context");
    expect(row.description).toContain("Add PATS");
  });

  it("carries the Airtable Request ID through as the hub ticket number", () => {
    const [row] = transformTechRequests([techRecord({ [T.requestId]: 151 })]).rows;
    expect(row.number).toBe(151);
  });

  it("uses Date Submitted for createdAt, falling back to the record creation time", () => {
    const [withDate] = transformTechRequests([
      techRecord({ [T.dateSubmitted]: "2026-05-27" }),
    ]).rows;
    expect(withDate.createdAt.toISOString().slice(0, 10)).toBe("2026-05-27");

    const [withoutDate] = transformTechRequests([techRecord({})]).rows;
    expect(withoutDate.createdAt.toISOString().slice(0, 10)).toBe("2026-02-05");
  });

  it("maps the Epic intake fields, including the YNHHS yes/no", () => {
    const [row] = transformTechRequests([
      techRecord({
        [T.jobTitle]: sel("Medical Student"),
        [T.epicIdToMirror]: "thomassy",
        [T.worksAtYnhh]: sel("Yes"),
        [T.startDate]: "2026-08-03",
      }),
    ]).rows;
    expect(row.epicJobTitle).toBe("Medical Student");
    expect(row.epicMirrorId).toBe("thomassy");
    expect(row.worksAtYnhh).toBe(true);
    expect(row.epicStartDate?.toISOString().slice(0, 10)).toBe("2026-08-03");
  });

  it("never carries the government ID or NetID out of Airtable", () => {
    const [row] = transformTechRequests([
      techRecord({ [T.governmentId]: "123456789", [T.netId]: "abc12" }),
    ]).rows;
    // Sensitive, and TechRequest.govId/netId were deliberately removed as dead.
    expect(JSON.stringify(row)).not.toContain("123456789");
    expect(JSON.stringify(row)).not.toContain("abc12");
  });

  it("treats the YNHHS 'No' answer as false, not as absent", () => {
    const [row] = transformTechRequests([techRecord({ [T.worksAtYnhh]: sel("No") })]).rows;
    expect(row.worksAtYnhh).toBe(false);
  });

  it("leaves worksAtYnhh null when Airtable never answered", () => {
    const [row] = transformTechRequests([techRecord({})]).rows;
    expect(row.worksAtYnhh).toBeNull();
  });

  it("normalises the inline RITM number, dropping placeholder values", () => {
    const [real] = transformTechRequests([
      techRecord({ [T.ynhhTicketNumber]: " RITM0311472 " }),
    ]).rows;
    expect(real.serviceRequestNumber).toBe("RITM0311472");

    const [placeholder] = transformTechRequests([
      techRecord({ [T.ynhhTicketNumber]: "RITM" }),
    ]).rows;
    expect(placeholder.serviceRequestNumber).toBeNull();
  });

  it("rejects a row whose requester link is missing rather than inventing one", () => {
    const result = transformTechRequests([techRecord({ [T.requester]: [] })]);
    expect(result.rows).toHaveLength(0);
    expect(result.skipped).toEqual([{ recordId: "recTech1", reason: "no requester link" }]);
  });

  it("only proposes an Epic request when Airtable recorded a kind", () => {
    const [withKind] = transformTechRequests([
      techRecord({ [T.epicIssueType]: sel("Renewal") }),
    ]).rows;
    expect(withKind.epicSubtype).toBe("RENEW");

    // 4 Epic-category rows in the source carry no kind; they stay plain tickets.
    const [withoutKind] = transformTechRequests([techRecord({})]).rows;
    expect(withoutKind.epicSubtype).toBeNull();
  });

  it("collects attachment metadata for later download", () => {
    const [row] = transformTechRequests([
      techRecord({
        [T.attachments]: [
          {
            id: "attW0Xz76Ub0HxTF8",
            url: "https://example.invalid/help-desk.png",
            filename: "help desk.png",
            size: 94306,
            type: "image/png",
          },
        ],
      }),
    ]).rows;
    expect(row.attachments).toEqual([
      {
        airtableId: "attW0Xz76Ub0HxTF8",
        url: "https://example.invalid/help-desk.png",
        filename: "help desk.png",
        size: 94306,
        mimeType: "image/png",
      },
    ]);
  });
});

describe("serviceRequestKey", () => {
  it("trims surrounding whitespace and a trailing period", () => {
    expect(serviceRequestKey(" RITM0340236")).toBe("RITM0340236");
    expect(serviceRequestKey("RITM0345762.")).toBe("RITM0345762");
  });

  it("rejects placeholders that carry no ticket number", () => {
    expect(serviceRequestKey("RITM")).toBeNull();
    expect(serviceRequestKey("INC")).toBeNull();
    expect(serviceRequestKey("")).toBeNull();
    expect(serviceRequestKey(null)).toBeNull();
  });
});

describe("resolveTrackerPersonName", () => {
  const roster = ["Iris Becene", "Clare Mullen", "Alec Yariel Luna", "Emily Ma", "Emily Mahoney"];

  it("strips the trailing request-kind words before matching", () => {
    expect(resolveTrackerPersonName("Iris Becene Renew", roster)).toBe("Iris Becene");
    expect(resolveTrackerPersonName("Clare Mullen PHAM New", roster)).toBe("Clare Mullen");
    expect(resolveTrackerPersonName("Alec Yariel Luna PATS Mod", roster)).toBe("Alec Yariel Luna");
  });

  it("prefers an exact name over a longer name that merely contains it", () => {
    expect(resolveTrackerPersonName("Emily Ma New", roster)).toBe("Emily Ma");
  });

  it("returns null rather than guessing when the text names no one resolvable", () => {
    expect(resolveTrackerPersonName("3 PATS people", roster)).toBeNull();
    expect(resolveTrackerPersonName("Someone Not On Roster New", roster)).toBeNull();
  });

  it("returns null when the cleaned text matches more than one person", () => {
    expect(resolveTrackerPersonName("Emily", roster)).toBeNull();
  });
});

describe("epicIntakeNote", () => {
  it("renders the access window and YNHHS employment", () => {
    expect(
      epicIntakeNote({
        epicStartDate: new Date("2026-08-03T00:00:00Z"),
        epicEndDate: new Date("2026-12-31T00:00:00Z"),
        worksAtYnhh: true,
      }),
    ).toBe("Imported from Airtable. Access from 2026-08-03. Access until 2026-12-31. Works at YNHHS.");
  });

  it("records a negative YNHHS answer rather than omitting it", () => {
    expect(epicIntakeNote({ epicStartDate: null, epicEndDate: null, worksAtYnhh: false })).toBe(
      "Imported from Airtable. Does not work at YNHHS.",
    );
  });

  it("returns null when Airtable recorded none of it", () => {
    expect(epicIntakeNote({ epicStartDate: null, epicEndDate: null, worksAtYnhh: null })).toBeNull();
  });
});

describe("inferTrackerKind", () => {
  it.each([
    ["Iris Becene Renew", "RENEW"],
    ["Nadia Idris PHAM New", "NEW"],
    ["Alec Yariel Luna PATS Mod", "MODIFY"],
    ["Annika Braceros PHAM Modify", "MODIFY"],
    ["Elijah Bacal New Account", "NEW"],
  ])("reads %s as %s", (brief, expected) => {
    expect(inferTrackerKind(brief)).toBe(expected);
  });

  it("prefers Modification when a row names both", () => {
    expect(inferTrackerKind("Ashley Cooper New Account Modify")).toBe("MODIFY");
  });

  it("returns null when no kind is named, rather than defaulting", () => {
    expect(inferTrackerKind("3 PATS people")).toBeNull();
    expect(inferTrackerKind("Mary Shamon Ayala")).toBeNull();
  });
});

describe("transformTrackerTickets", () => {
  const trackerRecord = (fields: Record<string, unknown>, id = "recY1") => ({
    id,
    fields: {
      [Y.briefDescription]: "Iris Becene Renew",
      [Y.submitter]: sel("Renée Tracey"),
      [Y.serviceRequestNumber]: "RITM0344243",
      [Y.ticketStatus]: [sel("Closed")],
      [Y.dateSubmitted]: "2026-07-09T12:22:00.000Z",
      ...fields,
    },
    createdTime: "2026-07-10T12:20:35.000Z",
  });

  it("groups rows that share a service request number into one ticket", () => {
    const { tickets } = transformTrackerTickets([
      trackerRecord({ [Y.briefDescription]: "June Park PHAM New" }, "recA"),
      trackerRecord({ [Y.briefDescription]: "Urvi Mysore PHAM New" }, "recB"),
    ]);
    expect(tickets).toHaveLength(1);
    expect(tickets[0].serviceRequestNumber).toBe("RITM0344243");
    expect(tickets[0].sourceRecordIds).toEqual(["recA", "recB"]);
    expect(tickets[0].description).toContain("June Park");
    expect(tickets[0].description).toContain("Urvi Mysore");
  });

  it("keeps rows with a placeholder number separate, keyed on their record id", () => {
    const { tickets } = transformTrackerTickets([
      trackerRecord({ [Y.serviceRequestNumber]: "RITM" }, "recA"),
      trackerRecord({ [Y.serviceRequestNumber]: "RITM" }, "recB"),
    ]);
    expect(tickets).toHaveLength(2);
    expect(tickets.map((t) => t.serviceRequestNumber)).toEqual([null, null]);
    expect(tickets.map((t) => t.airtableRecordId)).toEqual(["recA", "recB"]);
  });

  it("closes a ticket only when every grouped row is closed", () => {
    const { tickets: closed } = transformTrackerTickets([trackerRecord({})]);
    expect(closed[0].status).toBe("CLOSED");

    const { tickets: mixed } = transformTrackerTickets([
      trackerRecord({ [Y.ticketStatus]: [sel("Closed")] }, "recA"),
      trackerRecord({ [Y.ticketStatus]: [sel("Waiting on YNHH")] }, "recB"),
    ]);
    expect(mixed[0].status).toBe("OPEN");
  });

  it("carries the submitted and closed timestamps", () => {
    const { tickets } = transformTrackerTickets([
      trackerRecord({ [Y.dateClosed]: "2026-07-15T00:53:38.000Z" }),
    ]);
    expect(tickets[0].submittedAt.toISOString()).toBe("2026-07-09T12:22:00.000Z");
    expect(tickets[0].closedAt?.toISOString()).toBe("2026-07-15T00:53:38.000Z");
  });

  it("keeps ticket notes and reports the submitter name for resolution", () => {
    const { tickets } = transformTrackerTickets([
      trackerRecord({ [Y.ticketNotes]: "They sent the temp password but never closed it" }),
    ]);
    expect(tickets[0].notes).toContain("temp password");
    expect(tickets[0].submitterName).toBe("Renée Tracey");
  });
});
