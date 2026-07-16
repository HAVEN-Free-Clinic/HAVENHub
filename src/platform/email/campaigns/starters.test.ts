/**
 * Guards on the campaign starters. A campaign body may only reference the two
 * merge variables a campaign resolves (`firstName` / `name`); any other token makes
 * `updateCampaign` reject the body on Save/Send. These tests prove every starter's
 * subject + body validate against exactly that allow-list (so a seeded draft can
 * always be saved and sent) and lock in the key links + coverage of the welcome copy.
 */

import { describe, expect, it } from "vitest";
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
