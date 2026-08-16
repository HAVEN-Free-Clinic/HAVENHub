/**
 * Route-level authorization for applicant file downloads (audit 14, TSI-04).
 *
 * Resumes and CVs carry an applicant's name, address, and work history, and
 * this route had no test at all. canViewApplication is unit-tested as a pure
 * function, but nothing proved the route wires it to the signed-in reviewer, nor
 * that the storedName format check (the only thing standing between the URL and
 * an arbitrary object key) is still in place.
 *
 * Only auth() and storage are mocked; the review scope, the RBAC engine, and
 * Prisma are real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";

vi.mock("@/platform/auth/auth", () => ({ auth: vi.fn() }));
vi.mock("@/platform/storage", () => ({ getObject: vi.fn() }));

import { auth } from "@/platform/auth/auth";
import { getObject } from "@/platform/storage";
import { GET } from "./route";

const RESUME = Buffer.from("%PDF-1.4 resume");
/** persistFiles' format: "<fieldKey>-<uuid>[.ext]". The route rejects anything else. */
const STORED_NAME = "resume-11111111-2222-3333-4444-555555555555.pdf";

function signedInAs(personId: string | null): void {
  vi.mocked(auth).mockResolvedValue((personId ? { personId } : null) as never);
}

function call(applicationId: string, key: string, query = ""): Promise<Response> {
  return GET(
    new Request(
      `https://hub.test/api/recruitment/applications/${applicationId}/files/${key}${query}`,
    ),
    { params: Promise.resolve({ applicationId, key }) },
  );
}

async function person(name: string) {
  return prisma.person.create({ data: { name } });
}

let roleSeq = 0;
async function grant(personId: string, permission: string) {
  const role = await prisma.role.create({
    data: {
      name: `Role-${permission}-${++roleSeq}`,
      isSystem: false,
      grants: { create: [{ permission }] },
    },
  });
  await prisma.roleAssignment.create({ data: { roleId: role.id, personId, termId: null } });
}

async function applicationWithResume(creatorId: string, storedName = STORED_NAME) {
  const term = await prisma.term.create({
    data: {
      code: "SU26",
      name: "Summer 2026",
      startDate: new Date("2026-05-01T12:00:00Z"),
      endDate: new Date("2026-08-01T12:00:00Z"),
    },
  });
  const cycle = await prisma.recruitmentCycle.create({
    data: {
      track: "VOLUNTEER",
      termId: term.id,
      title: "Volunteer 2026",
      publicSlug: "vol-2026",
      createdById: creatorId,
    },
  });
  const applicant = await prisma.applicant.create({
    data: {
      cycleId: cycle.id,
      firstName: "Ada",
      lastName: "Lovelace",
      email: "Ada@example.com",
      emailLower: "ada@example.com",
    },
  });
  return prisma.application.create({
    data: {
      cycleId: cycle.id,
      applicantId: applicant.id,
      answers: {
        resume: { storedName, fileName: "Ada Resume.pdf", mimeType: "application/pdf" },
      },
      departmentChoices: [],
      subcommitteeRanking: [],
      languagesClaimed: [],
    },
  });
}

beforeEach(async () => {
  await resetDb();
  vi.clearAllMocks();
  vi.mocked(getObject).mockResolvedValue(RESUME);
});

describe("GET /api/recruitment/applications/[applicationId]/files/[key]", () => {
  it("serves a reviewer who may see the application", async () => {
    const reviewer = await person("SRR Reviewer");
    await grant(reviewer.id, "recruitment.review_all");
    const app = await applicationWithResume(reviewer.id);
    signedInAs(reviewer.id);

    const res = await call(app.id, "resume");

    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(RESUME);
    // Keyed by the application's own cycle, never by anything in the URL.
    expect(vi.mocked(getObject)).toHaveBeenCalledWith(`recruitment/${app.cycleId}/${STORED_NAME}`);
  });

  it("refuses a signed-in stranger, and never reads the bytes", async () => {
    const creator = await person("Cycle Creator");
    const stranger = await person("Stranger");
    const app = await applicationWithResume(creator.id);
    signedInAs(stranger.id);

    const res = await call(app.id, "resume");

    // 404, not 403: a stranger must not learn the file exists.
    expect(res.status).toBe(404);
    expect(vi.mocked(getObject)).not.toHaveBeenCalled();
  });

  it("refuses an unauthenticated request", async () => {
    const creator = await person("Cycle Creator");
    const app = await applicationWithResume(creator.id);
    signedInAs(null);

    expect((await call(app.id, "resume")).status).toBe(401);
    expect(vi.mocked(getObject)).not.toHaveBeenCalled();
  });

  it("404s a key the application has no answer for", async () => {
    const reviewer = await person("SRR Reviewer");
    await grant(reviewer.id, "recruitment.review_all");
    const app = await applicationWithResume(reviewer.id);
    signedInAs(reviewer.id);

    expect((await call(app.id, "transcript")).status).toBe(404);
    expect(vi.mocked(getObject)).not.toHaveBeenCalled();
  });

  it("refuses a stored name that is not the server-generated format", async () => {
    const reviewer = await person("SRR Reviewer");
    await grant(reviewer.id, "recruitment.review_all");
    // A traversal payload can only get here through a corrupted/injected answer,
    // but the route is the last line that can still refuse to fetch it.
    const app = await applicationWithResume(reviewer.id, "../../../etc/passwd");
    signedInAs(reviewer.id);

    expect((await call(app.id, "resume")).status).toBe(404);
    expect(vi.mocked(getObject)).not.toHaveBeenCalled();
  });
});
