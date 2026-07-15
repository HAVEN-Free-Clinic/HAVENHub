import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { RecruitmentAuthError } from "./review";
import { setRouteThresholds, RouteThresholdError } from "./route-thresholds";

async function seed() {
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
  const lead = await prisma.person.create({ data: { name: "Lead", status: "ACTIVE" } });
  const other = await prisma.person.create({ data: { name: "Other", status: "ACTIVE" } });
  const role = await prisma.role.create({ data: { name: "SRR", grants: { create: [{ permission: "recruitment.review_all" }] } } });
  await prisma.roleAssignment.create({ data: { personId: lead.id, roleId: role.id } });
  const cycle = await prisma.recruitmentCycle.create({ data: { track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "v", departments: ["EDUC"], createdById: lead.id, status: "OPEN" } });
  return { lead, other, cycle };
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

describe("route thresholds", () => {
  it("defaults new cycles to 20 top / 30 bottom", async () => {
    const { cycle } = await seed();
    expect(cycle.routeTopPercent).toBe(20);
    expect(cycle.routeBottomPercent).toBe(30);
  });

  it("a lead can set valid thresholds and it audits", async () => {
    const { lead, cycle } = await seed();
    await setRouteThresholds(cycle.id, 15, 40, lead.id);
    const fresh = await prisma.recruitmentCycle.findUniqueOrThrow({ where: { id: cycle.id } });
    expect(fresh.routeTopPercent).toBe(15);
    expect(fresh.routeBottomPercent).toBe(40);
    const audit = await prisma.auditLog.findFirst({ where: { action: "recruitment.route_thresholds" } });
    expect(audit).not.toBeNull();
  });

  it("rejects a non-lead", async () => {
    const { other, cycle } = await seed();
    await expect(setRouteThresholds(cycle.id, 20, 30, other.id)).rejects.toBeInstanceOf(RecruitmentAuthError);
  });

  it("rejects a sum over 100", async () => {
    const { lead, cycle } = await seed();
    await expect(setRouteThresholds(cycle.id, 60, 50, lead.id)).rejects.toBeInstanceOf(RouteThresholdError);
  });

  it("rejects an out-of-range or non-integer percent", async () => {
    const { lead, cycle } = await seed();
    await expect(setRouteThresholds(cycle.id, -1, 30, lead.id)).rejects.toBeInstanceOf(RouteThresholdError);
    await expect(setRouteThresholds(cycle.id, 20, 30.5, lead.id)).rejects.toBeInstanceOf(RouteThresholdError);
  });
});
