import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  assignByIdentifiers,
  createForm,
  deleteForm,
  fillableForm,
  formsForPerson,
  getForm,
  listResponses,
  pendingFormCount,
  remindNonResponders,
  responsesCsv,
  setFormStatus,
  submitResponse,
  summarize,
  updateForm,
  FormConflictError,
  FormError,
} from "./service";
import type { FormLayout } from "./layout";

beforeEach(resetDb);

const LAYOUT: FormLayout = {
  questions: [
    { key: "rating", type: "rating", label: "Overall", scale: { max: 5 }, required: true },
    { key: "pick", type: "single_choice", label: "Pick", options: ["A", "B"] },
    { key: "why", type: "long_text", label: "Why?" },
  ],
};

async function person(name: string, netId: string) {
  return prisma.person.create({ data: { name, netId, contactEmail: `${netId}@yale.edu`, status: "ACTIVE" } });
}

async function openForm(actorId: string, opts: { openToAnyone?: boolean; allowEdits?: boolean; closesAt?: Date | null } = {}) {
  const { id } = await createForm(actorId, { title: "Feedback" });
  await updateForm(actorId, id, {
    title: "Feedback",
    description: "",
    layout: LAYOUT,
    openToAnyone: opts.openToAnyone ?? false,
    allowEdits: opts.allowEdits ?? true,
    closesAt: opts.closesAt ?? null,
  });
  await setFormStatus(actorId, id, "OPEN");
  return id;
}

describe("building", () => {
  it("seeds a new form from a template", async () => {
    const staff = await person("Staff", "st1");
    const { id } = await createForm(staff.id, { title: "", templateId: "recruitment-feedback" });
    const form = await getForm(id);
    expect(form?.title).toBe("Volunteer recruitment feedback");
    expect(form?.parsedLayout.questions.length).toBeGreaterThan(10);
    expect(form?.status).toBe("DRAFT");
  });

  it("refuses a save loaded at an older version", async () => {
    const a = await person("Alex Kim", "ak1");
    const { id } = await createForm(a.id, { title: "F" });
    const base = { title: "F", description: "", layout: LAYOUT, openToAnyone: false, allowEdits: true, closesAt: null };
    await updateForm(a.id, id, { ...base, expectedVersion: 0 });
    await expect(updateForm(a.id, id, { ...base, expectedVersion: 0 })).rejects.toBeInstanceOf(FormConflictError);
    await expect(updateForm(a.id, id, base)).resolves.toBeUndefined();
  });

  it("will not open a form with no questions", async () => {
    const a = await person("A", "a1");
    const { id } = await createForm(a.id, { title: "Empty" });
    await expect(setFormStatus(a.id, id, "OPEN")).rejects.toBeInstanceOf(FormError);
  });

  it("deletes only a form with no responses", async () => {
    const a = await person("A", "a1");
    const id = await openForm(a.id, { openToAnyone: true });
    await submitResponse(a.id, id, { rating: "5" });
    await expect(deleteForm(a.id, id)).rejects.toBeInstanceOf(FormError);
  });
});

describe("who may respond", () => {
  it("hides drafts, and hides an assigned-only form from people not assigned", async () => {
    const staff = await person("Staff", "st1");
    const sam = await person("Sam Rivera", "sr1");
    const { id: draft } = await createForm(staff.id, { title: "Draft" });
    expect(await fillableForm(sam.id, draft)).toBeNull();

    const id = await openForm(staff.id);
    expect(await fillableForm(sam.id, id)).toBeNull();
    await expect(submitResponse(sam.id, id, { rating: "4" })).rejects.toBeInstanceOf(FormError);

    await assignByIdentifiers(staff.id, id, ["SR1"], { notify: false });
    expect(await fillableForm(sam.id, id)).not.toBeNull();
  });

  it("lets anyone signed in respond to an open-link form", async () => {
    const staff = await person("Staff", "st1");
    const sam = await person("Sam Rivera", "sr1");
    const id = await openForm(staff.id, { openToAnyone: true });
    await submitResponse(sam.id, id, { rating: "4", pick: "A" });
    expect((await listResponses(id))[0]).toMatchObject({ name: "Sam Rivera", answers: { rating: "4", pick: "A" } });
  });

  it("allows edits only when the form does, and nothing after it closes", async () => {
    const staff = await person("Staff", "st1");
    const sam = await person("Sam Rivera", "sr1");
    const locked = await openForm(staff.id, { openToAnyone: true, allowEdits: false });
    await submitResponse(sam.id, locked, { rating: "3" });
    await expect(submitResponse(sam.id, locked, { rating: "4" })).rejects.toThrow(/already responded/);

    const editable = await openForm(staff.id, { openToAnyone: true, closesAt: new Date("2026-10-10T00:00:00Z") });
    await submitResponse(sam.id, editable, { rating: "3" }, new Date("2026-10-05T00:00:00Z"));
    await submitResponse(sam.id, editable, { rating: "5" }, new Date("2026-10-06T00:00:00Z"));
    expect((await listResponses(editable)).map((r) => r.answers.rating)).toEqual(["5"]);
    await expect(
      submitResponse(sam.id, editable, { rating: "1" }, new Date("2026-10-11T00:00:00Z")),
    ).rejects.toThrow(/no longer accepting/);
  });

  it("refuses an invalid answer set with the problems listed", async () => {
    const staff = await person("Staff", "st1");
    const id = await openForm(staff.id, { openToAnyone: true });
    const err = await submitResponse(staff.id, id, { pick: "C" }).catch((e) => e);
    expect(err).toBeInstanceOf(FormError);
    expect((err as FormError).problems).toEqual(['Answer "Overall".', 'Pick one of the listed options for "Pick".']);
  });
});

describe("assignment", () => {
  it("assigns by NetID or email, reports misses, emails only newly assigned people", async () => {
    const staff = await person("Staff", "st1");
    await person("Ana Diaz", "ad1");
    await person("Ben Ortiz", "bo2");
    const id = await openForm(staff.id);

    const first = await assignByIdentifiers(staff.id, id, ["ad1", "BO2@YALE.EDU", "ghost"], { notify: true });
    expect(first).toEqual({ added: 2, alreadyAssigned: 0, emailed: 2, notFound: ["ghost"] });
    const second = await assignByIdentifiers(staff.id, id, ["ad1"], { notify: true });
    expect(second).toEqual({ added: 0, alreadyAssigned: 1, emailed: 0, notFound: [] });

    const mail = await prisma.emailLog.findMany({ where: { template: "forms:assigned" } });
    expect(mail.map((m) => m.toEmail).sort()).toEqual(["ad1@yale.edu", "bo2@yale.edu"]);
    expect(mail[0].html).toContain(`/my-info/forms/${id}`);
  });

  it("tracks pending forms and reminds only non-responders", async () => {
    const staff = await person("Staff", "st1");
    const ana = await person("Ana Diaz", "ad1");
    const ben = await person("Ben Ortiz", "bo2");
    const id = await openForm(staff.id);
    await assignByIdentifiers(staff.id, id, ["ad1", "bo2"], { notify: false });

    expect(await pendingFormCount(ana.id)).toBe(1);
    await submitResponse(ana.id, id, { rating: "5" });
    expect(await pendingFormCount(ana.id)).toBe(0);
    expect((await formsForPerson(ana.id))[0].submittedAt).not.toBeNull();

    expect(await remindNonResponders(staff.id, id)).toBe(1);
    const reminders = await prisma.emailLog.findMany({ where: { template: "forms:reminder" } });
    expect(reminders.map((r) => r.personId)).toEqual([ben.id]);
  });
});

describe("results", () => {
  it("summarizes choices, ratings and text", async () => {
    const staff = await person("Staff", "st1");
    const a = await person("Ana Diaz", "ad1");
    const b = await person("Ben Ortiz", "bo2");
    const id = await openForm(staff.id, { openToAnyone: true });
    await submitResponse(a.id, id, { rating: "5", pick: "A", why: "Great" });
    await submitResponse(b.id, id, { rating: "3", pick: "A" });

    const [rating, pick, why] = summarize(LAYOUT, await listResponses(id));
    expect(rating).toMatchObject({ kind: "rating", answered: 2, average: 4, counts: [0, 0, 1, 0, 1] });
    expect(pick).toMatchObject({ kind: "choice", answered: 2, counts: [{ option: "A", count: 2 }, { option: "B", count: 0 }] });
    expect(why).toMatchObject({ kind: "text", answered: 1, answers: [{ name: "Ana Diaz", text: "Great" }] });
  });

  it("exports CSV with formula injection neutralized", () => {
    const csv = responsesCsv(LAYOUT, [
      {
        id: "r1",
        personId: null,
        name: "Ana, Diaz",
        email: null,
        submittedAt: new Date("2026-10-01T12:00:00Z"),
        source: "HUB",
        answers: { rating: "5", why: '=HYPERLINK("x")' },
      },
    ]);
    const [header, row] = csv.split("\r\n");
    expect(header).toBe("Name,Email,Submitted,Source,Overall,Pick,Why?");
    expect(row).toBe(`"Ana, Diaz",,2026-10-01T12:00:00.000Z,Hub,5,,"'=HYPERLINK(""x"")"`);
  });
});
