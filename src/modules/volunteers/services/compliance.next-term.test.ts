import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { masterCompliance } from "./compliance";

/**
 * The master roster for the NEXT term.
 *
 * Promotion creates each recruit's HIPAA certificate from their onboarding
 * upload, unverified, and the onboarding gate holds anyone without a verified
 * one as soon as their term is live. The roster read the live term only, so a
 * recruit on next term's roster alone could not be found to verify until after
 * the flip had already locked them out.
 */

beforeEach(resetDb);

const DAY = 24 * 60 * 60 * 1000;

async function seed() {
  const live = await prisma.term.create({
    data: {
      code: "SU26", name: "Summer 2026", status: "ACTIVE",
      startDate: new Date(Date.now() - 90 * DAY), endDate: new Date(Date.now() + 15 * DAY),
    },
  });
  const next = await prisma.term.create({
    data: {
      code: "FA26", name: "Fall 2026", status: "PLANNING",
      startDate: new Date(Date.now() + 20 * DAY), endDate: new Date(Date.now() + 130 * DAY),
    },
  });
  const dept = await prisma.department.create({ data: { code: "PCAR", name: "Primary Care" } });
  const returner = await prisma.person.create({ data: { name: "Rita Returner", status: "ACTIVE" } });
  const recruit = await prisma.person.create({ data: { name: "Nora New", status: "ACTIVE" } });
  const departing = await prisma.person.create({ data: { name: "Dan Departing", status: "ACTIVE" } });
  await prisma.termMembership.createMany({
    data: [
      { personId: returner.id, termId: live.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" },
      { personId: returner.id, termId: next.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" },
      { personId: recruit.id, termId: next.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" },
      { personId: departing.id, termId: live.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" },
    ],
  });
  // What promotion leaves a brand-new recruit: their onboarding upload, unverified.
  await prisma.hipaaCertificate.create({
    data: {
      personId: recruit.id, fileName: "hipaa.pdf", storedName: "hipaa.pdf", size: 1,
      mimeType: "application/pdf", completionDate: new Date(Date.now() - 5 * DAY), source: "IMPORT",
    },
  });
  return { live, next };
}

const names = (result: Awaited<ReturnType<typeof masterCompliance>>) =>
  result.rows.map((r) => r.person.name).sort();

describe("masterCompliance for the next term", () => {
  it("lists next term's roster, including people promoted onto it alone", async () => {
    const { next } = await seed();
    expect(names(await masterCompliance({ termId: next.id }))).toEqual(["Nora New", "Rita Returner"]);
  });

  it("surfaces an onboarding certificate awaiting verification before the flip", async () => {
    const { next } = await seed();
    const result = await masterCompliance({ termId: next.id, status: "PENDING_VERIFICATION" });
    expect(names(result)).toEqual(["Nora New"]);
    expect(result.summary.PENDING_VERIFICATION).toBe(1);
  });

  it("shows the live roster by default", async () => {
    await seed();
    expect(names(await masterCompliance({}))).toEqual(["Dan Departing", "Rita Returner"]);
  });

  it("reads a term that is neither live nor next as the live roster", async () => {
    await seed();
    const archived = await prisma.term.create({
      data: {
        code: "SP26", name: "Spring 2026", status: "ARCHIVED",
        startDate: new Date(Date.now() - 300 * DAY), endDate: new Date(Date.now() - 200 * DAY),
      },
    });
    expect(names(await masterCompliance({ termId: archived.id }))).toEqual(["Dan Departing", "Rita Returner"]);
  });
});
