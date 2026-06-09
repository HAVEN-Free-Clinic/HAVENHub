import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  createDraft, updateCampaign, previewAudience, sendCampaignNow,
  CampaignValidationError, CampaignConfirmationError,
} from "./service";

beforeEach(resetDb);

async function activePerson(name: string, email: string) {
  return prisma.person.create({ data: { name, contactEmail: email, status: "ACTIVE" } });
}

const ALL_ACTIVE = { recordType: "PERSON" as const, match: "ALL" as const, conditions: [{ field: "status", op: "eq" as const, value: "ACTIVE" }] };

describe("campaign service", () => {
  it("creates a draft, updates it, previews recipients", async () => {
    await activePerson("Sam Rivera", "sam@example.com");
    const c = await createDraft(null, "Newsletter");
    await updateCampaign(null, c.id, { subject: "Hi {{ firstName }}", body: "<p>{{ name }}</p>", audience: ALL_ACTIVE });
    const preview = await previewAudience(c.id);
    expect(preview.count).toBe(1);
    expect(preview.sample[0].email).toBe("sam@example.com");
  });

  it("rejects a body with unknown variables", async () => {
    const c = await createDraft(null, "Bad");
    await expect(
      updateCampaign(null, c.id, { subject: "x", body: "{{ bogus }}", audience: ALL_ACTIVE }),
    ).rejects.toBeInstanceOf(CampaignValidationError);
  });

  it("send-now enqueues one email per recipient and marks SENT", async () => {
    await activePerson("Sam Rivera", "sam@example.com");
    await activePerson("Pat Lee", "pat@example.com");
    const c = await createDraft(null, "Blast");
    await updateCampaign(null, c.id, { subject: "Hi {{ firstName }}", body: "<p>Hi {{ firstName }}</p>", audience: ALL_ACTIVE });
    const res = await sendCampaignNow(null, c.id, {});
    expect(res.recipientCount).toBe(2);
    const logs = await prisma.emailLog.findMany({ where: { campaignRunId: res.runId } });
    expect(logs.length).toBe(2);
    expect(logs.every((l) => l.html.includes("HAVEN Free Clinic"))).toBe(true);
    const after = await prisma.emailCampaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.status).toBe("SENT");
  });

  it("requires a matching typed count above the threshold", async () => {
    for (let i = 0; i < 26; i++) await activePerson(`P ${i}`, `p${i}@example.com`);
    const c = await createDraft(null, "Big");
    await updateCampaign(null, c.id, { subject: "s", body: "<p>hi</p>", audience: ALL_ACTIVE });
    await expect(sendCampaignNow(null, c.id, {})).rejects.toBeInstanceOf(CampaignConfirmationError);
    const ok = await sendCampaignNow(null, c.id, { confirmCount: 26 });
    expect(ok.recipientCount).toBe(26);
  });
});
