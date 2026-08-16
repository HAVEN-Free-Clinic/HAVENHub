import { log, errorAttrs } from "@/platform/logging";
import { intercomAccessToken } from "./config";

const INTERCOM_API = "https://api.intercom.io";

/**
 * Same pin as conversations.ts and identity.ts, and for the same reason: left
 * to the workspace default, this write's behavior would depend on a setting
 * this codebase does not control. See identity.ts's INTERCOM_API_VERSION doc
 * comment for the full rationale; duplicated here rather than imported
 * because these files intentionally have no dependency on each other.
 */
const INTERCOM_API_VERSION = "2.14";

/**
 * Ceiling on the ticket-number write-back. Same value and same reasoning as
 * conversations.ts's INTERCOM_REPLY_TIMEOUT_MS -- generous for one REST call,
 * comfortably inside a serverless function's own timeout -- kept as a
 * separate constant because this call site may reasonably need a different
 * budget later.
 */
export const INTERCOM_TICKET_WRITE_TIMEOUT_MS = 5_000;

/**
 * Same budget as INTERCOM_TICKET_WRITE_TIMEOUT_MS, kept as its own constant
 * because fetchTicketState below is called once per row inside the
 * reconciliation cron's paged loop (src/app/api/cron/intercom-reconcile) --
 * a batch of these adds up, unlike the one-off writes above -- so this name
 * gives that call site room to tune its own budget independently later.
 */
export const INTERCOM_TICKET_READ_TIMEOUT_MS = 5_000;

/**
 * The Intercom ticket-type attribute this write targets. Created 2026-08-11
 * on all six ticket types for exactly this purpose (see
 * docs/superpowers/specs/2026-08-12-intercom-ticket-sync-design.md).
 */
const HUB_TICKET_NUMBER_ATTRIBUTE = "Hub ticket number";

/**
 * Reads a Ticket's staff-facing state label out of an Intercom ticket object,
 * accepting either of the two serializations Intercom uses.
 *
 * Intercom changed this field's shape at API version 2.12, and every reader in
 * this codebase was written against the older one. Verified against the live
 * workspace on 2026-08-13 by fetching the same ticket at each version:
 *
 *   2.9 - 2.11  {"ticket_state": "resolved",
 *                "ticket_state_internal_label": "Resolved",
 *                "ticket_state_external_label": "Resolved"}
 *   2.12+       {"ticket_state": {"type": "ticket_state", "id": "4706546",
 *                                 "category": "resolved",
 *                                 "internal_label": "Resolved",
 *                                 "external_label": "Resolved"}}
 *
 * From 2.12 the flat `ticket_state_internal_label` key is simply gone, so
 * reading it against the 2.14 pin above always produced `undefined`. That was
 * one typo-shaped mistake with two silent consequences: the ticket.state.updated
 * webhook 400'd every delivery (it could not find a label to map), and
 * fetchTicketState below returned null for every ticket, which the
 * reconciliation cron counts as "Intercom unreachable" and skips -- so the
 * safety net built to catch exactly this kind of missed sync reported nothing
 * while checking nothing.
 *
 * BOTH shapes are accepted rather than only the current one, because the two
 * readers do not share a version knob. This module pins 2.14 on its own REST
 * calls, but a webhook payload is serialized at whatever version the Intercom
 * app is set to in the Developer Hub -- a dashboard setting, changeable by a
 * teammate who has never seen this file, and equally capable of moving back to
 * an older version as forward. Preferring the nested shape and falling back to
 * the flat one costs three lines and makes the reader correct under either.
 *
 * Deliberately does NOT fall back to a bare-string `ticket_state`
 * ("resolved", "in_progress", ...). That is the state's CATEGORY, not its
 * label, and this workspace's seven states collapse into four of them
 * (GET /ticket_states, 2026-08-13): "Resolved", "Won't fix", and "Cancelled"
 * all report category `resolved` while mapping to three DIFFERENT Hub statuses
 * (RESOLVED, CLOSED, CANCELLED), and "In progress" and "Waiting on YNHH ITS"
 * both report `in_progress`. Mapping a category would therefore be the
 * nearest-match guess that intercom-sync.ts's whole fail-closed posture exists
 * to prevent, and it would land a cancelled ticket on Resolved. Returning null
 * instead lets the caller refuse loudly, which is the designed behavior for a
 * state this codebase cannot identify.
 */
export function extractTicketStateInternalLabel(ticket: unknown): string | null {
  if (!ticket || typeof ticket !== "object") return null;
  const record = ticket as Record<string, unknown>;

  const state = record.ticket_state;
  if (state && typeof state === "object") {
    const nested = (state as Record<string, unknown>).internal_label;
    if (typeof nested === "string" && nested.trim() !== "") return nested;
  }

  const flat = record.ticket_state_internal_label;
  if (typeof flat === "string" && flat.trim() !== "") return flat;

  return null;
}

/**
 * Writes the Hub's ticket `number` onto an Intercom Ticket's "Hub ticket
 * number" attribute (`PUT /tickets/{id}`, `ticket_attributes`).
 *
 * This is the write-back Direction 1's earlier attempt could not do: that
 * path (src/app/api/support/tickets/from-conversation/route.ts) only ever
 * had a conversation id, and this attribute lives in the Ticket Type
 * attribute namespace -- a different write surface from a conversation's
 * custom_attributes, which cannot reach it at all (see that route's doc
 * comment for the full explanation). The ticket.created webhook is the first
 * place a real Intercom ticket id exists to write through.
 *
 * Best-effort, deliberately: the ticket already exists and the member already
 * has their number by the time this runs (see the design's "Step 4 is
 * best-effort" note), so a failed write-back is a cosmetic problem, not a
 * reason to fail the webhook. Never throws -- unconfigured, network error,
 * timeout, and non-2xx all resolve to `false` and are logged, the same
 * fail-closed shape as postConversationNote and resolveIdentityFromConversation.
 */
export async function pushTicketNumber(ticketId: string, number: number): Promise<boolean> {
  const token = intercomAccessToken();
  if (!token) return false;

  const endpoint = "tickets/:id";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), INTERCOM_TICKET_WRITE_TIMEOUT_MS);
  try {
    const res = await fetch(`${INTERCOM_API}/tickets/${encodeURIComponent(ticketId)}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "Intercom-Version": INTERCOM_API_VERSION,
      },
      body: JSON.stringify({
        ticket_attributes: { [HUB_TICKET_NUMBER_ATTRIBUTE]: number },
      }),
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) {
      log.warn("[intercom] ticket number write-back failed", {
        endpoint,
        version: INTERCOM_API_VERSION,
        status: res.status,
      });
      return false;
    }
    return true;
  } catch (err) {
    // Catches a network failure and an abort (the timeout above) alike -- see
    // the matching comment in identity.ts.
    log.warn(
      "[intercom] ticket number write-back failed",
      errorAttrs(err, { endpoint, version: INTERCOM_API_VERSION })
    );
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Trim, lowercase, and fold a typographic apostrophe to a straight one, so two
 * spellings of the same workspace state label compare equal.
 *
 * Lives here rather than in intercom-sync.ts, where it started, because BOTH
 * layers now need it: that module folds an inbound label before looking it up
 * in its mapping table, and resolveTicketStateId below folds the same label
 * before matching it against the workspace's own state list. src/platform must
 * not import src/modules, so the shared piece has to sit on this side of the
 * boundary; intercom-sync.ts imports it from here.
 *
 * The fold matters because "Won't fix" uses U+0027 in the workspace today, but
 * that label is editable in Intercom's UI, and an editor that auto-substitutes
 * quotes would turn it into U+2019 -- a label that looks identical in every log
 * line and screenshot while missing every comparison.
 */
export function normalizeTicketStateLabel(label: string): string {
  return label.trim().toLowerCase().replace(/’/g, "'");
}

/**
 * How long a resolved label -> state id map is reused before being re-fetched.
 *
 * Workspace ticket states change when ops edits them in Intercom's UI, which is
 * a rare, human-paced event, so a few minutes of staleness costs nothing and
 * saves a second round trip on every status push. A stale map cannot silently
 * write the WRONG state, only fail to write one: ids are stable per state, so
 * staleness shows up either as an id Intercom now rejects (a non-2xx that
 * pushTicketState logs, and that drops the cache -- see below) or as a label
 * that is missing from the map, which refuses the write and logs. A missing
 * label deliberately does NOT drop the cache: the only labels ever pushed come
 * from intercom-sync.ts's own table, so one that the workspace does not have is
 * a standing code-vs-workspace mismatch, and re-fetching the list on every push
 * would hammer Intercom for as long as it lasted.
 */
export const TICKET_STATE_CACHE_TTL_MS = 5 * 60 * 1000;

let ticketStateCache: { expiresAt: number; byLabel: Map<string, string> } | null = null;

/**
 * Drops the cached label -> state id map, forcing the next push to re-resolve.
 *
 * Called when Intercom rejects a state write, which is the one signal available
 * that the map may be describing a workspace that no longer exists (a state
 * renamed, archived, or recreated with a new id). Also the reset hook the tests
 * use between cases, since the cache is module-level by design.
 */
export function resetTicketStateCache(): void {
  ticketStateCache = null;
}

/**
 * Resolves a workspace state's staff-facing label to the state id that
 * `PUT /tickets/{id}` requires, via `GET /ticket_states`.
 *
 * This lookup exists because Intercom changed the update-ticket contract at API
 * 2.12, the same version boundary that moved the state label on the read side
 * (see extractTicketStateInternalLabel above):
 *
 *   2.11 and earlier   PUT /tickets/{id}  {"state": "<label>"}
 *   2.12 and later     PUT /tickets/{id}  {"ticket_state_id": "<id>"}
 *
 * This module pins 2.14, so the old `state` key was simply not a property the
 * endpoint accepts. Intercom ignores unrecognized body properties rather than
 * rejecting them, which made this the quietest possible failure: a 200 came
 * back, pushTicketState returned true, nothing was logged, and the ticket's
 * state never moved.
 *
 * Unlike the read side, this write does NOT accept both shapes. The version a
 * webhook payload arrives in is a Developer Hub setting this codebase does not
 * control, but the version of an outbound REST call is the constant at the top
 * of this file -- so there is exactly one correct contract here, and honoring
 * the older one too would mean sending a key that 2.14 ignores.
 *
 * Matching is by internal_label rather than by category, for the same reason
 * extractTicketStateInternalLabel refuses to read a category: "Resolved",
 * "Won't fix", and "Cancelled" all share the `resolved` category in this
 * workspace, so a category match could write a member's cancelled ticket to
 * Resolved. Archived states are skipped -- they cannot be assigned, and an
 * archived state sharing a label with a live one would otherwise shadow it.
 *
 * Returns null when the label is not a state this workspace has, which
 * pushTicketState treats as a refusal to write rather than as a fallback to
 * some nearest state.
 */
async function resolveTicketStateId(token: string, stateLabel: string): Promise<string | null> {
  const wanted = normalizeTicketStateLabel(stateLabel);

  const cached = ticketStateCache;
  if (cached && cached.expiresAt > Date.now()) {
    return cached.byLabel.get(wanted) ?? null;
  }

  const endpoint = "ticket_states";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), INTERCOM_TICKET_READ_TIMEOUT_MS);
  try {
    const res = await fetch(`${INTERCOM_API}/ticket_states`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Intercom-Version": INTERCOM_API_VERSION,
      },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) {
      log.warn("[intercom] ticket state list read failed", {
        endpoint,
        version: INTERCOM_API_VERSION,
        status: res.status,
      });
      return null;
    }

    const body = (await res.json()) as { data?: unknown };
    const byLabel = new Map<string, string>();
    for (const entry of Array.isArray(body.data) ? body.data : []) {
      if (!entry || typeof entry !== "object") continue;
      const state = entry as Record<string, unknown>;
      if (state.archived === true) continue;
      const label = state.internal_label;
      const id = state.id;
      if (typeof label !== "string" || label.trim() === "") continue;
      if (typeof id !== "string" && typeof id !== "number") continue;
      // First writer wins, so a duplicate label cannot make which id gets
      // written depend on response order.
      const key = normalizeTicketStateLabel(label);
      if (!byLabel.has(key)) byLabel.set(key, String(id));
    }

    ticketStateCache = { expiresAt: Date.now() + TICKET_STATE_CACHE_TTL_MS, byLabel };
    return byLabel.get(wanted) ?? null;
  } catch (err) {
    // Catches a network failure and an abort (the timeout above) alike -- see
    // the matching comment in identity.ts.
    log.warn("[intercom] ticket state list read failed", errorAttrs(err, { endpoint, version: INTERCOM_API_VERSION }));
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Writes a new state onto an Intercom Ticket (`PUT /tickets/{id}`,
 * `ticket_state_id`).
 *
 * This is the outward half of Direction 3 (see
 * docs/superpowers/specs/2026-08-12-intercom-ticket-sync-design.md): a Hub
 * status change setting the Ticket's state so the member sees it in
 * Intercom's own UI, natively, with no Hub-authored text crossing over. The
 * inbound half reads that same state back out of the webhook payload (see
 * extractTicketStateInternalLabel above).
 *
 * Deliberately generic: takes a plain string label, not a TechRequestStatus.
 * Which label corresponds to which Hub status is a support-module concern
 * (src/modules/support/services/intercom-sync.ts's mapStatusToIntercomTicketState),
 * and src/platform must not import src/modules -- so the mapping happens one
 * layer up, and this function only ever moves a string across the wire. The
 * label-to-id resolution that 2.12+ requires (resolveTicketStateId above) is a
 * property of the Intercom workspace rather than of the Hub's statuses, so it
 * belongs on this side of that boundary and this signature does not change.
 *
 * Same fail-closed, never-throw posture and the same timeout budget as
 * pushTicketNumber: unconfigured, unresolvable label, network error, timeout,
 * and non-2xx all resolve to `false` and are logged, never thrown -- a Hub
 * status change must commit even when Intercom is unreachable.
 */
export async function pushTicketState(ticketId: string, stateLabel: string): Promise<boolean> {
  const token = intercomAccessToken();
  if (!token) return false;

  const stateId = await resolveTicketStateId(token, stateLabel);
  if (!stateId) {
    // Either Intercom could not be reached for the state list (already logged
    // by the resolver) or the workspace has no state by this label -- someone
    // renamed or removed one in Intercom's UI without a matching change to
    // intercom-sync.ts's outbound table. Refuses rather than guessing at a
    // nearest state, matching the inbound half's posture exactly.
    log.warn("[intercom] could not resolve an Intercom ticket state id for the label", {
      endpoint: "ticket_states",
      version: INTERCOM_API_VERSION,
      stateLabel,
    });
    return false;
  }

  const endpoint = "tickets/:id";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), INTERCOM_TICKET_WRITE_TIMEOUT_MS);
  try {
    const res = await fetch(`${INTERCOM_API}/tickets/${encodeURIComponent(ticketId)}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "Intercom-Version": INTERCOM_API_VERSION,
      },
      body: JSON.stringify({ ticket_state_id: stateId }),
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) {
      // A rejected state id is the one available signal that the cached map
      // describes a workspace that has moved on (a state archived, renamed, or
      // recreated), so drop it rather than re-sending the same dead id for the
      // rest of the TTL.
      resetTicketStateCache();
      log.warn("[intercom] ticket state write-back failed", {
        endpoint,
        version: INTERCOM_API_VERSION,
        status: res.status,
      });
      return false;
    }
    return true;
  } catch (err) {
    // Catches a network failure and an abort (the timeout above) alike -- see
    // the matching comment in identity.ts.
    log.warn(
      "[intercom] ticket state write-back failed",
      errorAttrs(err, { endpoint, version: INTERCOM_API_VERSION })
    );
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Reads an Intercom Ticket's current staff-facing state label, the same value
 * the ticket.state.updated webhook carries in its payload -- which is why both
 * readers go through extractTicketStateInternalLabel above rather than reaching
 * for a field name (see that function for the two shapes and why the field name
 * alone is not safe to depend on). See also intercom-sync.ts's
 * mapIntercomTicketStateToStatus, which this call site reuses to interpret the
 * label the same way inbound and reconciliation do.
 *
 * This is the read half Direction 3's webhook never needed: a webhook either
 * arrives or it does not, and when Intercom retries a failed delivery there is
 * nothing more to poll for. A delivery that Intercom gives up on entirely (or
 * an outage on our side at the moment it fired) leaves no further retry and no
 * trace to notice the loss by -- that gap is what the reconciliation cron
 * (src/app/api/cron/intercom-reconcile) exists to close, and it can only do
 * that by asking Intercom directly instead of waiting for an event that may
 * never come.
 *
 * Same fail-closed, never-throw posture as pushTicketNumber/pushTicketState
 * above: unconfigured, network error, timeout, and non-2xx all resolve to
 * `null` and are logged, never thrown. The cron treats `null` as "could not
 * check this one right now" and skips it, never as evidence of drift --
 * an unreachable Intercom must not manufacture a mismatch report.
 */
export async function fetchTicketState(ticketId: string): Promise<string | null> {
  return extractTicketStateInternalLabel(await fetchTicket(ticketId));
}

/**
 * The whole Ticket object, for the callers that need more of it than its state.
 *
 * Split out of fetchTicketState (which is now a one-line composition over it)
 * rather than given a second implementation, because everything interesting
 * here is the parts a copy would get subtly wrong: the pinned API version, the
 * read timeout, and the never-throw posture. The recovery script
 * (scripts/recover-intercom-ticket.ts) needs the ticket's attributes and type
 * as well as its state, and a script with its own hand-rolled fetch is the
 * copy that rots first.
 *
 * Returns the parsed body, or null on anything that is not a 2xx -- same
 * fail-closed shape as every other read in this module. Untyped on purpose: the
 * shape varies by ticket type and by API version, and each caller already
 * type-guards the specific fields it reads (extractTicketStateInternalLabel is
 * the in-repo example).
 */
export async function fetchTicket(ticketId: string): Promise<unknown | null> {
  const token = intercomAccessToken();
  if (!token) return null;

  const endpoint = "tickets/:id";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), INTERCOM_TICKET_READ_TIMEOUT_MS);
  try {
    const res = await fetch(`${INTERCOM_API}/tickets/${encodeURIComponent(ticketId)}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Intercom-Version": INTERCOM_API_VERSION,
      },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) {
      log.warn("[intercom] ticket state read failed", {
        endpoint,
        version: INTERCOM_API_VERSION,
        status: res.status,
      });
      return null;
    }
    return await res.json();
  } catch (err) {
    // Catches a network failure and an abort (the timeout above) alike -- see
    // the matching comment in identity.ts.
    log.warn("[intercom] ticket state read failed", errorAttrs(err, { endpoint, version: INTERCOM_API_VERSION }));
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
