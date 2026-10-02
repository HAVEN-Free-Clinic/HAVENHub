import { expect, test } from "@playwright/test";
import { loginAs } from "./auth";
import { prisma, tag } from "./fixtures";

/**
 * The co-editing and lifecycle surfaces of the campaign editor: the stale-save
 * refusal and its "Save anyway", the presence banner, moving a scheduled
 * campaign back to draft, and the read-only view of a sent campaign with its
 * delivery breakdown and activity log.
 *
 * Campaigns are seeded straight into the database rather than built through
 * the editor: what is under test is how the page renders and acts on a given
 * state, and the editor's own authoring flow is covered by
 * email-campaigns.spec.ts.
 */

const AUDIENCE = { recordType: "PERSON", match: "ALL", conditions: [] };

async function seedPerson(stamp: string, name: string) {
  return prisma.person.create({
    data: { name: `${name} ${stamp}`, contactEmail: `${stamp}-${name.toLowerCase()}@example.com`, status: "ACTIVE" },
  });
}

test("campaign co-editing: a stale save is refused, then overwritten on request", async ({ page }) => {
  const stamp = tag();
  const other = await seedPerson(stamp, "Blair");
  const campaign = await prisma.emailCampaign.create({
    data: { name: `Coedit ${stamp}`, audienceJson: AUDIENCE, subject: "Original", body: "<p>Hi</p>" },
  });
  try {
    await loginAs(page, "admin");
    // Someone else is in the editor right now.
    await prisma.emailCampaignPresence.create({ data: { campaignId: campaign.id, personId: other.id } });
    await page.goto(`/outreach/campaigns/${campaign.id}`);
    await expect(page.getByText(`${other.name} is also editing this campaign.`)).toBeVisible();

    // ...and saves while this editor is open.
    await prisma.emailCampaign.update({
      where: { id: campaign.id },
      data: { subject: "Theirs", contentVersion: { increment: 1 }, updatedById: other.id },
    });

    await page.fill('input[name="subject"]', "Mine");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText(/Your changes are NOT saved yet/)).toBeVisible();
    expect((await prisma.emailCampaign.findUniqueOrThrow({ where: { id: campaign.id } })).subject).toBe("Theirs");

    await page.getByRole("button", { name: "Save anyway" }).click();
    await page.waitForURL(/saved=1|tab=compose/);
    await expect
      .poll(async () => (await prisma.emailCampaign.findUniqueOrThrow({ where: { id: campaign.id } })).subject)
      .toBe("Mine");
  } finally {
    await prisma.emailCampaign.delete({ where: { id: campaign.id } }).catch(() => {});
    await prisma.person.delete({ where: { id: other.id } }).catch(() => {});
  }
});

test("campaign lifecycle: a scheduled campaign moves back to an editable draft", async ({ page }) => {
  const stamp = tag();
  const campaign = await prisma.emailCampaign.create({
    data: {
      name: `Scheduled ${stamp}`,
      audienceJson: AUDIENCE,
      subject: "Later",
      body: "<p>Hi</p>",
      status: "SCHEDULED",
      scheduleType: "SCHEDULED",
      scheduledAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      nextRunAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    },
  });
  try {
    await loginAs(page, "admin");
    await page.goto(`/outreach/campaigns/${campaign.id}`);
    await expect(page.getByText("Scheduled to send on")).toBeVisible();
    await page.getByRole("button", { name: "Move back to draft" }).click();
    await page.waitForURL(/unscheduled=1|\/outreach\/campaigns\/[a-z0-9]+$/);
    await expect(page.locator('input[name="subject"]')).toHaveValue("Later");
    await expect
      .poll(async () => (await prisma.emailCampaign.findUniqueOrThrow({ where: { id: campaign.id } })).status)
      .toBe("DRAFT");
  } finally {
    await prisma.emailCampaign.delete({ where: { id: campaign.id } }).catch(() => {});
  }
});

test("campaign delivery: a sent campaign shows its message, delivery counts, failures and activity", async ({ page }) => {
  const stamp = tag();
  const campaign = await prisma.emailCampaign.create({
    data: { name: `Sent ${stamp}`, audienceJson: AUDIENCE, subject: "Done", body: "<p>Body text</p>", status: "SENT" },
  });
  const run = await prisma.emailCampaignRun.create({ data: { campaignId: campaign.id, recipientCount: 2 } });
  await prisma.emailLog.createMany({
    data: [
      { toEmail: `${stamp}-ok@example.com`, subject: "Done", html: "h", template: "campaign", campaignRunId: run.id, status: "SENT", sentAt: new Date() },
      { toEmail: `${stamp}-bad@example.com`, subject: "Done", html: "h", template: "campaign", campaignRunId: run.id, status: "FAILED", lastError: "550 mailbox unavailable" },
    ],
  });
  await prisma.auditLog.create({
    data: { action: "campaign.send", entityType: "EmailCampaign", entityId: campaign.id, after: { recipientCount: 2 } },
  });
  try {
    await loginAs(page, "admin");
    await page.goto(`/outreach/campaigns/${campaign.id}`);
    await expect(page.getByTitle("Campaign message")).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Delivered" })).toBeVisible();
    await expect(page.getByText(`${stamp}-bad@example.com`)).toBeVisible();
    await expect(page.getByText("550 mailbox unavailable")).toBeVisible();
    await expect(page.getByText("sent it to 2 recipients")).toBeVisible();

    await page.getByRole("button", { name: "Retry failed emails" }).click();
    await expect
      .poll(async () =>
        (await prisma.emailLog.findFirstOrThrow({ where: { campaignRunId: run.id, toEmail: `${stamp}-bad@example.com` } })).status,
      )
      .not.toBe("FAILED");
  } finally {
    await prisma.emailCampaign.delete({ where: { id: campaign.id } }).catch(() => {});
    await prisma.emailLog.deleteMany({ where: { toEmail: { startsWith: stamp } } }).catch(() => {});
  }
});
