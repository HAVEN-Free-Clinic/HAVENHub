import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { issueFeedToken } from "./feed-token";
import { CalendarSubscribeSection } from "./subscribe-section";

const noop = async () => {};

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

function makePerson() {
  return prisma.person.create({ data: { name: "Ada Lovelace", status: "ACTIVE" } });
}

/** The section is an async server component; call it, then render what it returns. */
async function render(personId: string): Promise<string> {
  const element = await CalendarSubscribeSection({
    personId,
    generateAction: noop,
    resetAction: noop,
  });
  return renderToStaticMarkup(element);
}

describe("CalendarSubscribeSection", () => {
  it("offers to generate a link when the member has no feed yet", async () => {
    const person = await makePerson();

    const markup = await render(person.id);

    expect(markup).toContain("Generate link");
    // The critical assertion: no address of any kind is rendered before one exists.
    expect(markup).not.toContain("/api/calendar/");
  });

  it("renders the member's real token in a .ics subscribe URL", async () => {
    const person = await makePerson();
    const token = await issueFeedToken(person.id);

    const markup = await render(person.id);

    expect(markup).toContain(`/api/calendar/${token}.ics`);
    expect(markup).toContain("Add to Google");
    expect(markup).toContain("Reset link");
  });

  it("carries the refresh-lag disclosure, which is the whole reason members trust the feed", async () => {
    const person = await makePerson();
    await issueFeedToken(person.id);

    // Matches "their own timing" (now that Outlook is offered alongside Google)
    // and would still match a singular rewording. The disclosure existing at all
    // is the point, not its exact phrasing.
    expect(await render(person.id)).toContain("own timing");
  });

  it("shows one member's token and never another's", async () => {
    const ada = await makePerson();
    const grace = await prisma.person.create({ data: { name: "Grace Hopper", status: "ACTIVE" } });
    const adaToken = await issueFeedToken(ada.id);
    const graceToken = await issueFeedToken(grace.id);

    const markup = await render(ada.id);

    expect(markup).toContain(adaToken);
    expect(markup).not.toContain(graceToken);
  });

  it("reflects a rotated token and drops the previous one", async () => {
    const person = await makePerson();
    const first = await issueFeedToken(person.id);
    const second = await issueFeedToken(person.id);

    const markup = await render(person.id);

    expect(markup).toContain(second);
    expect(markup).not.toContain(first);
  });
});
