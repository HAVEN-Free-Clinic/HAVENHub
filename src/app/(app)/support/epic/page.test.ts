/**
 * Loader wiring for /support/epic (audit 14, epic-history-unbounded-client-payload).
 *
 * The page used to run all seven loaders on every visit and serialize all seven
 * results into a client component, whichever tab was on screen -- including
 * getEpicRequestHistory, which returns EVERY YnhhTicket ever recorded with four
 * nested relations and no bound. Nothing about the RENDER changes when a tab's
 * unused props arrive full instead of empty, so the assertion has to be on which
 * loaders ran.
 *
 * The page function is called directly and its element tree inspected; nothing
 * is rendered, so the tab component is stubbed rather than executed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const loaders = vi.hoisted(() => ({
  listDepartmentsWithMembers: vi.fn(async () => []),
  getEpicRequestHistory: vi.fn(async () => []),
  listPendingDeactivations: vi.fn(async () => []),
  listEpicAuthorizers: vi.fn(async () => []),
  listIncidentPeople: vi.fn(async () => []),
  listPendingEpicRequests: vi.fn(async () => []),
  listLinkableTechRequests: vi.fn(async () => []),
}));

vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/platform/auth/session", () => ({
  requirePermission: vi.fn(async () => ({ personId: "p1" })),
}));
vi.mock("@/modules/support/services/itcm", () => ({
  ...loaders,
  // A real value, not a stub: the page reads it to decide the History cap and
  // passes it to the table, so a mock that omitted it made the page hand down
  // `undefined` and silently lose the "showing the N most recent" disclosure.
  EPIC_HISTORY_LIMIT: 200,
  closeTicket: vi.fn(),
  updateServiceRequestNumber: vi.fn(),
  logYnhhIncident: vi.fn(),
  resolveIncident: vi.fn(),
}));
vi.mock("@/modules/support/services/attachments", () => ({ persistAttachment: vi.fn() }));
vi.mock("@/modules/support/services/tech-request", () => ({
  SupportForbiddenError: class extends Error {},
  SupportNotFoundError: class extends Error {},
  SupportStateError: class extends Error {},
}));
vi.mock("@/modules/support/services/epic", () => ({
  createTicket: vi.fn(),
  completeRequest: vi.fn(),
  sendEpicEmail: vi.fn(),
  linkEpicRequestToTicket: vi.fn(),
  cancelEpicRequest: vi.fn(),
  EpicForbiddenError: class extends Error {},
  EpicNotFoundError: class extends Error {},
  EpicStateError: class extends Error {},
}));
vi.mock("@/platform/terms/active-term", () => ({ getActiveTerm: vi.fn(async () => null) }));
vi.mock("@/platform/terms/working-term", () => ({ getWorkingTerm: vi.fn(async () => null) }));
vi.mock("@/modules/support/services/epic-rollup", () => ({
  listBatchTermOptions: vi.fn(async () => []),
  loadTermEpicRollup: vi.fn(async () => null),
}));
vi.mock("@/platform/ui/page-header", () => ({ PageHeader: () => null }));
vi.mock("@/modules/support/components/epic-request-tabs", () => ({ EpicRequestTabs: () => null }));

import EpicRequestsPage from "./page";

async function visit(tab?: string) {
  await EpicRequestsPage({ searchParams: Promise.resolve(tab ? { tab } : {}) });
}

function called(): string[] {
  return Object.entries(loaders)
    .filter(([, fn]) => fn.mock.calls.length > 0)
    .map(([name]) => name)
    .sort();
}

describe("/support/epic loaders", () => {
  beforeEach(() => {
    for (const fn of Object.values(loaders)) fn.mockClear();
  });

  it("does not read the YNHH ticket history for the default Generate tab", async () => {
    await visit();

    expect(loaders.getEpicRequestHistory).not.toHaveBeenCalled();
    expect(called()).toEqual([
      "listDepartmentsWithMembers",
      "listEpicAuthorizers",
      "listPendingDeactivations",
    ]);
  });

  // The Tracker renders OPEN tickets and History renders CLOSED ones. Asking for
  // only the status the tab shows is what keeps the Tracker's payload bounded by
  // the work in flight instead of by the size of the archive, and it is the half
  // of the fix a "was it called" assertion cannot see (audit 14 follow-up).
  it("asks for only the ticket status the tab renders, and caps the closed archive", async () => {
    await visit("tracker");
    expect(loaders.getEpicRequestHistory).toHaveBeenCalledWith({ status: "OPEN" });

    loaders.getEpicRequestHistory.mockClear();
    await visit("history");
    expect(loaders.getEpicRequestHistory).toHaveBeenCalledWith({ status: "CLOSED", take: 200 });
  });

  it("reads the ticket history only for the tabs that render it", async () => {
    await visit("tracker");
    expect(loaders.getEpicRequestHistory).toHaveBeenCalledTimes(1);

    loaders.getEpicRequestHistory.mockClear();
    await visit("history");
    expect(loaders.getEpicRequestHistory).toHaveBeenCalledTimes(1);

    loaders.getEpicRequestHistory.mockClear();
    await visit("pending");
    expect(loaders.getEpicRequestHistory).not.toHaveBeenCalled();

    loaders.getEpicRequestHistory.mockClear();
    await visit("term-batch");
    expect(loaders.getEpicRequestHistory).not.toHaveBeenCalled();
  });

  it("still loads everything each tab renders", async () => {
    await visit("tracker");
    expect(called()).toEqual([
      "getEpicRequestHistory",
      "listIncidentPeople",
      "listLinkableTechRequests",
    ]);

    for (const fn of Object.values(loaders)) fn.mockClear();
    await visit("pending");
    expect(called()).toEqual(["listPendingEpicRequests"]);

    for (const fn of Object.values(loaders)) fn.mockClear();
    await visit("term-batch");
    expect(called()).toEqual(["listEpicAuthorizers"]);
  });
});
