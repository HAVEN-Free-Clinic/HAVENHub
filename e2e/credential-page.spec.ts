import { expect, test } from "@playwright/test";
import { cleanupPerson, prisma, tag } from "./fixtures";

test.describe("public credential page", () => {
  let personId: string;
  let token: string;

  test.beforeAll(async () => {
    token = `e2e-token-${tag()}`;
    const person = await prisma.person.create({ data: { name: `Credential Member ${tag()}` } });
    personId = person.id;
    await prisma.serviceCredential.create({
      data: {
        personId,
        publicToken: token,
        record: {
          name: person.name,
          memberSince: { label: "Summer 2026", source: "MEMBERSHIP" },
          terms: [
            {
              termCode: "SU26",
              termName: "Summer 2026",
              startDate: "2026-05-01T12:00:00.000Z",
              departmentName: "Internal Medicine",
              track: "VOLUNTEER",
              shifts: 4,
              source: "MEMBERSHIP",
            },
          ],
          capabilities: { spanishVerified: false, licensedRN: false },
          basis: "SCHEDULED",
          generatedAt: "2026-08-07T12:00:00.000Z",
        },
      },
    });
  });

  test.afterAll(async () => {
    // cleanupPerson does not know about ServiceCredential, so it is removed
    // here first (the FK constraint cascades, but deleting explicitly keeps
    // this spec's cleanup order self-documenting and safe regardless).
    await prisma.serviceCredential.deleteMany({ where: { personId } });
    await cleanupPerson(personId);
  });

  test("an unknown token renders not found", async ({ page }) => {
    const response = await page.goto("/credential/definitely-not-a-real-token");
    expect(response?.status()).toBe(404);
  });

  test("a published credential renders without a session", async ({ browser }) => {
    // A fresh context with no storage state: the whole point is that this works
    // signed out. If the route ever drifts inside the (app) group, this fails.
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    await page.goto(`/credential/${token}`);
    await expect(page.getByRole("heading", { name: "Record of Service" })).toBeVisible();
    await expect(page.getByText("Internal Medicine")).toBeVisible();
    await context.close();
  });
});
