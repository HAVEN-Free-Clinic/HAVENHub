import { expect, test } from "@playwright/test";
import { prisma, tag } from "./fixtures";
import { applicantSessionCookie } from "./portal-cookie";

test.setTimeout(120_000);

async function devLogin(page: import("@playwright/test").Page, email: string) {
  await page.goto("/login");
  await page.fill('input[name="email"]', email);
  await page.click('button:has-text("Dev sign in")');
  await page.waitForURL((url) => url.pathname === "/");
}

test("apply: draw a signature field and submit; it persists as a png blob", async ({ page, context }) => {
  await devLogin(page, "j.carney@yale.edu");

  // Build + publish a minimal single-department volunteer cycle.
  const t = tag();
  await page.goto("/recruitment/cycles/new");
  await page.fill('input[name="title"]', "Signature E2E");
  const slug = `sig-${t}`;
  await page.fill('input[name="publicSlug"]', slug);
  await page.fill('input[name="departments"]', "SRHD");
  await page.uncheck('input[name="seedDefaultForm"]');
  await page.click('button:has-text("Create")');
  await page.waitForURL((url) => url.pathname.includes("/builder"));
  const cycleId = page.url().split("/cycles/")[1].split("/")[0];

  // Inject a required SIGNATURE field into the seeded identity section (key "signature").
  const section = await prisma.formSection.findFirstOrThrow({ where: { cycleId }, orderBy: { order: "asc" } });
  const maxOrder = (await prisma.formField.aggregate({ where: { cycleId }, _max: { order: true } }))._max.order ?? -1;
  await prisma.formField.create({
    data: { cycleId, sectionId: section.id, key: "signature", label: "Signature", type: "SIGNATURE", required: true, order: maxOrder + 1 },
  });

  await page.goto(`/recruitment/cycles/${cycleId}`);
  await page.click('button:has-text("Publish")');
  await expect(page.locator("span").filter({ hasText: "OPEN" })).toBeVisible();

  // Apply as a verified portal applicant.
  const applicantEmail = `e2e-sig-${t}@yale.edu`;
  const ctx = await context.browser()!.newContext();
  await ctx.addCookies([applicantSessionCookie(applicantEmail)]);
  const apply = await ctx.newPage();
  await apply.goto(`/apply/${slug}`);

  const firstName = apply.locator('input[name="first_name"]');
  if (await firstName.isVisible().catch(() => false)) {
    await firstName.fill("Sig");
    await apply.fill('input[name="last_name"]', "Ner");
    await apply.fill('input[name="email"]', applicantEmail);
  }

  // Draw on the signature canvas with real pointer movement.
  const canvas = apply.locator('canvas[aria-label^="Signature signature pad"]');
  await expect(canvas).toBeVisible();
  const box = (await canvas.boundingBox())!;
  await apply.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.4);
  await apply.mouse.down();
  await apply.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.7);
  await apply.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.3);
  await apply.mouse.up();
  await expect(apply.getByText("Signed")).toBeVisible();

  // Advance to review and submit.
  const submit = apply.getByRole("button", { name: "Submit application" });
  const continueBtn = apply.getByRole("button", { name: "Continue" });
  for (let i = 0; i < 8; i++) {
    // Settle on the step before acting: non-review steps show Continue, Review
    // shows Submit. Avoids the flaky blind-click of a Continue already replaced by
    // Submit on Review (which hung the whole test).
    await expect(continueBtn.or(submit)).toBeVisible({ timeout: 45_000 });
    if (await submit.isVisible().catch(() => false)) break;
    await continueBtn.click();
  }
  await expect(submit).toBeVisible();
  await submit.click();
  await expect(apply.getByText(/your application was received/i)).toBeVisible();
  await ctx.close();

  // The stored answer is a png file-ref, not the raw data URL.
  const applicant = await prisma.applicant.findFirstOrThrow({ where: { cycleId, emailLower: applicantEmail.toLowerCase() }, include: { applications: true } });
  const answers = applicant.applications[0].answers as Record<string, { mimeType?: string; storedName?: string; method?: string }>;
  expect(answers.signature.mimeType).toBe("image/png");
  expect(answers.signature.storedName).toMatch(/\.png$/);
  expect(answers.signature.method).toBe("draw");

  // Cleanup.
  await prisma.application.deleteMany({ where: { cycleId } });
  await prisma.applicant.deleteMany({ where: { cycleId } });
});

// The pad's typed-name fallback is a second, independent write path (rasterize
// text onto the shared canvas instead of tracking pointer strokes) that had
// critical bugs earlier; cover it end-to-end alongside the draw path above.
test("apply: type a signature via the fallback input and submit; it persists as a png blob", async ({ page, context }) => {
  await devLogin(page, "j.carney@yale.edu");

  // Build + publish a minimal single-department volunteer cycle.
  const t = tag();
  await page.goto("/recruitment/cycles/new");
  await page.fill('input[name="title"]', "Signature Type E2E");
  const slug = `sig-type-${t}`;
  await page.fill('input[name="publicSlug"]', slug);
  await page.fill('input[name="departments"]', "SRHD");
  await page.uncheck('input[name="seedDefaultForm"]');
  await page.click('button:has-text("Create")');
  await page.waitForURL((url) => url.pathname.includes("/builder"));
  const cycleId = page.url().split("/cycles/")[1].split("/")[0];

  // Inject a required SIGNATURE field into the seeded identity section (key "signature").
  const section = await prisma.formSection.findFirstOrThrow({ where: { cycleId }, orderBy: { order: "asc" } });
  const maxOrder = (await prisma.formField.aggregate({ where: { cycleId }, _max: { order: true } }))._max.order ?? -1;
  await prisma.formField.create({
    data: { cycleId, sectionId: section.id, key: "signature", label: "Signature", type: "SIGNATURE", required: true, order: maxOrder + 1 },
  });

  await page.goto(`/recruitment/cycles/${cycleId}`);
  await page.click('button:has-text("Publish")');
  await expect(page.locator("span").filter({ hasText: "OPEN" })).toBeVisible();

  // Apply as a verified portal applicant.
  const applicantEmail = `e2e-sigtype-${t}@yale.edu`;
  const ctx = await context.browser()!.newContext();
  await ctx.addCookies([applicantSessionCookie(applicantEmail)]);
  const apply = await ctx.newPage();
  await apply.goto(`/apply/${slug}`);

  const firstName = apply.locator('input[name="first_name"]');
  if (await firstName.isVisible().catch(() => false)) {
    await firstName.fill("Sig");
    await apply.fill('input[name="last_name"]', "Typer");
    await apply.fill('input[name="email"]', applicantEmail);
  }

  // Switch the pad to the typed-name fallback and fill it in.
  const canvas = apply.locator('canvas[aria-label^="Signature signature pad"]');
  await expect(canvas).toBeVisible();
  await apply.click('button:has-text("Type instead")');
  const typedInput = apply.locator('input[aria-label^="Signature typed signature"]');
  await typedInput.fill("Sig Typer");
  await expect(apply.getByText("Signed")).toBeVisible();

  // Advance to review and submit.
  const submit = apply.getByRole("button", { name: "Submit application" });
  const continueBtn = apply.getByRole("button", { name: "Continue" });
  for (let i = 0; i < 8; i++) {
    // Settle on the step before acting: non-review steps show Continue, Review
    // shows Submit. Avoids the flaky blind-click of a Continue already replaced by
    // Submit on Review (which hung the whole test).
    await expect(continueBtn.or(submit)).toBeVisible({ timeout: 45_000 });
    if (await submit.isVisible().catch(() => false)) break;
    await continueBtn.click();
  }
  await expect(submit).toBeVisible();
  await submit.click();
  await expect(apply.getByText(/your application was received/i)).toBeVisible();
  await ctx.close();

  // The stored answer is a png file-ref recorded with the "type" method.
  const applicant = await prisma.applicant.findFirstOrThrow({ where: { cycleId, emailLower: applicantEmail.toLowerCase() }, include: { applications: true } });
  const answers = applicant.applications[0].answers as Record<string, { mimeType?: string; storedName?: string; method?: string }>;
  expect(answers.signature.mimeType).toBe("image/png");
  expect(answers.signature.storedName).toMatch(/\.png$/);
  expect(answers.signature.method).toBe("type");

  // Cleanup.
  await prisma.application.deleteMany({ where: { cycleId } });
  await prisma.applicant.deleteMany({ where: { cycleId } });
});
