/**
 * Guards on the campaign starters. A campaign body may only reference the two
 * merge variables a campaign resolves (`firstName` / `name`); any other token makes
 * `updateCampaign` reject the body on Save/Send. These tests prove every starter's
 * subject + body validate against exactly that allow-list (so a seeded draft can
 * always be saved and sent) and lock in the key links + coverage of the welcome copy.
 */

import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { validateTemplate } from "@/platform/email/render/validate";
import { PERSON_VARIABLES } from "@/platform/email/audience/variables";
import { CAMPAIGN_STARTERS, getStarter } from "./starters";

const ALLOWED = PERSON_VARIABLES.map((v) => v.name);

describe("campaign starters", () => {
  it("registers the welcome starter and resolves it by id", () => {
    expect(getStarter("welcome")).toBeDefined();
    expect(getStarter("does-not-exist")).toBeUndefined();
    // Ids are unique.
    const ids = CAMPAIGN_STARTERS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(CAMPAIGN_STARTERS)(
    "$id subject + body only reference the two campaign merge variables",
    (starter) => {
      const subject = validateTemplate(starter.subject, ALLOWED);
      expect(subject.unknownVariables).toEqual([]);
      expect(subject.errors).toEqual([]);
      expect(subject.ok).toBe(true);

      const body = validateTemplate(starter.body, ALLOWED);
      expect(body.unknownVariables).toEqual([]);
      expect(body.errors).toEqual([]);
      expect(body.ok).toBe(true);
    },
  );

  it("welcome starter links the hub and the docs, and never recreates the layout chrome", () => {
    const welcome = getStarter("welcome")!;
    expect(welcome.body).toContain("https://hub.havenfreeclinic.org");
    expect(welcome.body).toContain("https://docs.havenfreeclinic.org");
    // The shared layout owns the document + header + footer; the starter is a
    // content fragment only.
    expect(welcome.body).not.toContain("<html");
    expect(welcome.body).not.toContain("<body");
    // It must not hard-code a {{ brandColor }} token (the body cannot resolve it).
    expect(welcome.body).not.toContain("brandColor");
  });

  // A hero that 404s is worse than no hero: it renders as a broken-image icon at
  // the very top of a welcome email, and nothing in the app would ever surface
  // it. The file has to exist in public/ AND be referenced absolutely, because a
  // relative path resolves against the mail client rather than the Hub.
  it("welcome starter's hero image is absolute and actually exists in public/", () => {
    const body = getStarter("welcome")!.body;
    const src = /<img[^>]+src="([^"]+)"/.exec(body)?.[1];
    expect(src).toBeDefined();
    expect(src!.startsWith("https://")).toBe(true);

    const path = new URL(src!).pathname;
    expect(existsSync(join(process.cwd(), "public", path))).toBe(true);

    // Outlook reserves space from the width/height attributes, and an image with
    // no alt text is a blank gap for anyone with images off, which on Outlook is
    // the default.
    expect(body).toMatch(/<img[^>]+width="\d+"[^>]+height="\d+"/);
    expect(body).toMatch(/<img[^>]+alt="[^"]{20,}"/);
  });

  it("welcome starter covers each capability group", () => {
    const body = getStarter("welcome")!.body.toLowerCase();
    for (const phrase of [
      "clearance", // My Info + compliance
      "schedule",
      "training",
      "epic", // IT & Epic support
      "concern", // incident reports
      "notified", // notifications
      "record of service", // passport / service record
      "languages", // language verification
    ]) {
      expect(body).toContain(phrase);
    }
  });

  // The capabilities are deliberately grouped into labelled mini-sections rather
  // than listed as one uniform run of rows: a single undifferentiated block is
  // what readers skip. Each group also names where to click, so the eyebrow is
  // not the only thing telling someone how to get there.
  it("welcome starter groups the capabilities into labelled sections that say where to click", () => {
    const body = getStarter("welcome")!.body;
    for (const eyebrow of ["Stay in the loop", "My Info", "Scheduling", "Also in the Hub"]) {
      expect(body).toContain(`text-transform:uppercase;color:#00356b;">${eyebrow}<`);
    }
    // "Stay in the loop" leads, ahead of the record-keeping and scheduling groups.
    expect(body.indexOf(">Stay in the loop<")).toBeLessThan(body.indexOf(">My Info<"));
    expect(body.indexOf(">My Info<")).toBeLessThan(body.indexOf(">Scheduling<"));
    expect(body.indexOf(">Scheduling<")).toBeLessThan(body.indexOf(">Also in the Hub<"));
    // Every group ends with its own "where to click" line naming the top navigation.
    expect(body.match(/top bar of every page|from the top navigation|in the top navigation/g)).toHaveLength(4);
  });

  // Who you are on with is a facet of the schedule, not a peer of it. It had its
  // own row once and that split is part of what made the flat panel read as nine
  // unrelated things; promoting it to its own card would repeat the mistake in the
  // new layout. It has to stay a bullet inside SCHEDULING.
  it("welcome starter keeps who-is-on-with-you inside the scheduling group", () => {
    const body = getStarter("welcome")!.body;
    const scheduling = body.indexOf(">Scheduling<");
    const nextGroup = body.indexOf(">Also in the Hub<");
    const whoIsOn = body.indexOf("Who is on with you");
    expect(scheduling).toBeGreaterThan(-1);
    expect(whoIsOn).toBeGreaterThan(scheduling);
    expect(whoIsOn).toBeLessThan(nextGroup);
    // ...as a bullet, never as a group eyebrow of its own.
    expect(body).not.toContain('text-transform:uppercase;color:#00356b;">Who is on with you<');
    // It still answers "how do I find the right person mid-shift", which is the
    // whole reason the material exists.
    expect(body).toContain("attending is covering");
    expect(body).toMatch(/verified language provider or a licensed RN/);
  });

  // The theme control is its own toolbar button and deliberately NOT in the
  // account menu (see platform/ui/account-menu.tsx), so copy that sends people
  // to the account menu for it sends them to the wrong place.
  it("welcome starter does not point at the account menu for the theme control", () => {
    const body = getStarter("welcome")!.body.toLowerCase();
    expect(body).toContain("theme button in the top bar");
    expect(body).not.toContain("account menu");
  });
});
