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
    ]) {
      expect(body).toContain(phrase);
    }
  });
});
