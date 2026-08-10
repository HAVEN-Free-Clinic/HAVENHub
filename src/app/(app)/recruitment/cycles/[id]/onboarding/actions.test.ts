import { describe, it, expect, vi } from "vitest";

// redirect() signals by throwing NEXT_REDIRECT; capture the target instead.
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw new Error(`REDIRECT:${url}`); },
}));
// Set per test, so one seeded actor can drive every action.
const session = { personId: "" };
vi.mock("@/platform/auth/session", () => ({
  requirePersonSession: async () => session,
}));
vi.mock("@/platform/posthog/capture", () => ({ captureEvent: vi.fn() }));
vi.mock("@/platform/posthog/groups", () => ({ termGroupForCycle: async () => ({ term: "t" }) }));
// resetDb() (below) clears the settings module's process-global cache via
// _resetSettingsCache, so the mock must still provide that export even though
// getSetting itself is stubbed.
vi.mock("@/platform/settings/service", () => ({
  getSetting: async () => "https://hub.test",
  _resetSettingsCache: vi.fn(),
}));

import { afterEach, beforeEach } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { seedCycle } from "@/modules/recruitment/test/seed-cycle";

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

import { sendLinksAction, promoteAction, withdrawAction } from "./actions";

function form(ids: string[]) {
  const fd = new FormData();
  for (const id of ids) fd.append("acceptanceId", id);
  return fd;
}

/** Run an action and return the URL it redirected to.
 *
 * bounce() builds its query string with URLSearchParams, which encodes a space
 * as "+" per application/x-www-form-urlencoded -- the same convention a real
 * searchParams reader decodes back. decodeURIComponent alone leaves "+"
 * literal, so it is translated to a space first to match that convention. */
async function target(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    const m = (e as Error).message;
    if (m.startsWith("REDIRECT:")) {
      return decodeURIComponent(m.slice("REDIRECT:".length).replace(/\+/g, " "));
    }
    throw e;
  }
  throw new Error("expected a redirect");
}

describe("onboarding bulk actions", () => {
  it("rejects an empty selection", async () => {
    const { cycleId, srrId } = await seedCycle([{}]);
    session.personId = srrId;
    const url = await target(() => sendLinksAction(cycleId, form([])));
    expect(url).toContain("err=");
    expect(url).toContain("Select at least one");
  });

  // Scoping is the guard against a forged id from another cycle.
  it("ignores an acceptance that belongs to another cycle", async () => {
    const a = await seedCycle([{}]);
    const b = await seedCycle([{}]);
    session.personId = a.srrId;
    const url = await target(() => sendLinksAction(a.cycleId, form([b.acceptances[0].id])));
    expect(url).toContain("Sent 0");
    expect(url).toContain("1 not eligible");
  });

  // Selecting an already-promoted row and hitting Send is routine once
  // select-all exists. It must read as informational, not as a red failure.
  it("reports an ineligible row as not eligible, not as a failure", async () => {
    const { cycleId, srrId, acceptances } = await seedCycle([
      {},
      { contract: { status: "PROMOTED" } },
    ]);
    session.personId = srrId;
    const url = await target(() =>
      sendLinksAction(cycleId, form([acceptances[0].id, acceptances[1].id])));
    expect(url).toContain("Sent 1");
    expect(url).toContain("1 not eligible");
    expect(url).not.toContain("err=");
  });

  it("promotes only the submitted rows in a mixed selection", async () => {
    const { cycleId, srrId, acceptances } = await seedCycle([
      { contract: { status: "SUBMITTED" } },
      { contract: { status: "PENDING" } },
    ]);
    session.personId = srrId;
    const url = await target(() =>
      promoteAction(cycleId, form([acceptances[0].id, acceptances[1].id])));
    expect(url).toContain("1 new");
    expect(url).toContain("1 not eligible");
  });

  it("withdraws a batch and reports the count", async () => {
    const { cycleId, srrId, acceptances } = await seedCycle([
      { contract: { status: "PENDING" } },
      { contract: { status: "PENDING" } },
    ]);
    session.personId = srrId;
    // bulkWithdraw="1" is what the real bulk Withdraw button submits, so it
    // must be present for withdrawAction to treat this as a genuine withdraw.
    const fd = form(acceptances.map((a) => a.id));
    fd.set("bulkWithdraw", "1");
    const url = await target(() => withdrawAction(cycleId, fd));
    expect(url).toContain("Withdrew 2");
    expect(url).toContain("You can now change the decision or resend a fresh link");
  });

  // The resend/re-decide hint is misleading when nothing was actually
  // withdrawn (e.g. the whole selection was already promoted).
  it("omits the resend hint when nothing was withdrawn", async () => {
    const { cycleId, srrId, acceptances } = await seedCycle([
      { contract: { status: "PROMOTED" } },
    ]);
    session.personId = srrId;
    const fd = form([acceptances[0].id]);
    fd.set("bulkWithdraw", "1");
    const url = await target(() => withdrawAction(cycleId, fd));
    expect(url).toContain("Withdrew 0");
    expect(url).not.toContain("You can now change the decision");
  });

  // The form's default action is withdraw (see onboarding-table.tsx), so any
  // future submit button added there without its own formAction would ride
  // this action too. Neither marker present must be refused, not treated as
  // an implicit bulk withdraw of whatever happens to be checked.
  it("refuses a submission carrying neither bulkWithdraw nor onlyAcceptanceId", async () => {
    const { cycleId, srrId, acceptances } = await seedCycle([
      { contract: { status: "PENDING" } },
    ]);
    session.personId = srrId;
    const url = await target(() => withdrawAction(cycleId, form([acceptances[0].id])));
    expect(url).toContain("err=");
    expect(url).toContain("cannot withdraw");
    expect(await prisma.onboardingContract.count()).toBe(1);
  });

  // The per-row Withdraw button rides in the same form as the checkboxes, so
  // its id must win outright or one row's button would withdraw the selection.
  it("acts on onlyAcceptanceId alone, ignoring checked rows", async () => {
    const { cycleId, srrId, acceptances } = await seedCycle([
      { contract: { status: "PENDING" } },
      { contract: { status: "PENDING" } },
    ]);
    session.personId = srrId;
    const fd = form(acceptances.map((a) => a.id));
    fd.set("onlyAcceptanceId", acceptances[0].id);
    const url = await target(() => withdrawAction(cycleId, fd));
    expect(url).toContain("Withdrew 1");
    expect(await prisma.onboardingContract.count()).toBe(1);
  });

  it("refuses an actor without recruitment.review_all", async () => {
    const { cycleId, plainId, acceptances } = await seedCycle([
      { contract: { status: "PENDING" } },
    ]);
    session.personId = plainId;
    // Carries the marker so this test exercises the permission check inside
    // withdrawContracts, not the isWithdrawSubmission guard above it.
    const fd = form([acceptances[0].id]);
    fd.set("bulkWithdraw", "1");
    const url = await target(() => withdrawAction(cycleId, fd));
    expect(url).toContain("err=");
    expect(await prisma.onboardingContract.count()).toBe(1);
  });
});
