import { vi } from "vitest";
import { resetTicketStateCache } from "@/platform/intercom/tickets";

/**
 * Test helpers for code that pushes an Intercom Ticket state.
 *
 * Every caller of pushTicketState (src/platform/intercom/tickets.ts) makes TWO
 * requests rather than one: from API 2.12, `PUT /tickets/{id}` takes a
 * `ticket_state_id`, not the state's label, so the label is resolved through
 * `GET /ticket_states` first. A test that stubs a single blanket-200 fetch and
 * reads `mock.calls[0]` therefore reads the STATE LIST call and not the write.
 *
 * These live here, rather than being re-hand-rolled in each of the five suites
 * that exercise an outbound push, so the workspace fixture and the "which call
 * was the write" question have one answer that moves with the wire format.
 */

/**
 * The workspace's ticket states, trimmed to the fields the resolver reads
 * (GET /ticket_states on 2026-08-13). Ids are the real ones, so a test asserting
 * on a specific id is asserting against something a live push would produce.
 */
export const INTERCOM_TICKET_STATES = [
  { type: "ticket_state", id: "4706543", category: "submitted", internal_label: "Submitted", archived: false },
  { type: "ticket_state", id: "4706544", category: "in_progress", internal_label: "In progress", archived: false },
  {
    type: "ticket_state",
    id: "4706545",
    category: "waiting_on_customer",
    internal_label: "Awaiting user",
    archived: false,
  },
  { type: "ticket_state", id: "4706546", category: "resolved", internal_label: "Resolved", archived: false },
  { type: "ticket_state", id: "8057332", category: "resolved", internal_label: "Won't fix", archived: false },
  { type: "ticket_state", id: "9632907", category: "in_progress", internal_label: "Waiting on YNHH ITS", archived: false },
  { type: "ticket_state", id: "9634938", category: "resolved", internal_label: "Cancelled", archived: false },
];

/** The state id a given staff-facing label resolves to, for assertions. */
export function intercomStateId(internalLabel: string): string {
  const state = INTERCOM_TICKET_STATES.find((s) => s.internal_label === internalLabel);
  if (!state) throw new Error(`No Intercom ticket state fixture for label "${internalLabel}"`);
  return state.id;
}

/**
 * Stubs global fetch so `GET /ticket_states` answers with the workspace fixture
 * and every other request succeeds with an empty 200 body. Returns the mock.
 *
 * Also clears the resolver's module-level label -> id cache, which by design
 * outlives a single test (see TICKET_STATE_CACHE_TTL_MS). Without that, whether
 * a given test sees the state-list request depends on which tests ran before
 * it, and a suite's call counts stop being reproducible in isolation.
 */
export function stubIntercomFetch(): ReturnType<typeof vi.fn> {
  resetTicketStateCache();
  const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    if (typeof url === "string" && url.includes("/ticket_states")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ type: "list", data: INTERCOM_TICKET_STATES }),
      });
    }
    void init;
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Every call the code under test made that was not the state-list lookup. */
export function intercomWriteCalls(fetchMock: ReturnType<typeof vi.fn>): [string, RequestInit][] {
  return (fetchMock.mock.calls as [string, RequestInit | undefined][])
    .filter(([url]) => !(typeof url === "string" && url.includes("/ticket_states")))
    .map(([url, init]) => [url, (init ?? {}) as RequestInit]);
}

/** The single write the code under test made, with its body already parsed. */
export function intercomWriteBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const calls = intercomWriteCalls(fetchMock);
  if (calls.length !== 1) throw new Error(`Expected exactly one Intercom write, saw ${calls.length}`);
  return JSON.parse(calls[0][1].body as string) as Record<string, unknown>;
}
