/**
 * Resolve a link to the current clinic week's Microsoft Teams channel.
 *
 * The clinic Team holds one channel per clinic week, each named "MM-DD-YY Clinic"
 * (e.g. "06-13-26 Clinic"). We compute the current clinic date from the active
 * term's clinicDates (America/New_York calendar; a clinic Saturday's channel
 * shows through that Saturday and rolls to the next at midnight into Sunday),
 * list the Team's channels via Microsoft Graph using the reused Mailer delegated
 * token, and return the matched channel's Graph-provided webUrl deeplink.
 *
 * Every failure path degrades to null so the dashboard simply hides the card.
 */

import { prisma } from "@/platform/db";
import { log, errorAttrs } from "@/platform/logging";
import { getAccessToken } from "@/platform/email/oauth";
import { getSetting } from "@/platform/settings/service";

/** A Microsoft Graph channel object (subset we use). */
export interface GraphChannel {
  id: string;
  displayName: string;
  webUrl: string;
}

/**
 * Return the YYYYMMDD integer for the America/New_York calendar date of an
 * instant. Clinic dates are anchored at 12:00 UTC, so their NY calendar date is
 * unambiguous; "now" is converted to its NY calendar date for comparison.
 */
function nyDateInt(d: Date): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const day = parts.find((p) => p.type === "day")!.value;
  return Number(`${y}${m}${day}`);
}

/**
 * Pick the earliest clinic date whose NY calendar date is >= today's NY calendar
 * date. The input may be in any order; it is sorted internally. Returns null
 * when there is no upcoming clinic date.
 */
export function selectCurrentClinicDate(
  clinicDates: Date[],
  now: Date
): Date | null {
  const today = nyDateInt(now);
  const upcoming = clinicDates
    .filter((d) => nyDateInt(d) >= today)
    .sort((a, b) => a.getTime() - b.getTime());
  return upcoming[0] ?? null;
}

/** Format a clinic date as zero-padded MM-DD-YY in America/New_York. */
export function formatClinicDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const m = parts.find((p) => p.type === "month")!.value;
  const d = parts.find((p) => p.type === "day")!.value;
  const y = parts.find((p) => p.type === "year")!.value;
  return `${m}-${d}-${y}`;
}

/**
 * Find the channel whose displayName starts with the MM-DD-YY date string
 * (trim + case-insensitive). Returns null when none match.
 */
export function matchChannel(
  channels: GraphChannel[],
  dateStr: string
): GraphChannel | null {
  const target = dateStr.trim().toLowerCase();
  return (
    channels.find((c) =>
      (c.displayName ?? "").trim().toLowerCase().startsWith(target)
    ) ?? null
  );
}

/** The resolved link for the current clinic week's Teams channel. */
export interface ClinicChannelLink {
  webUrl: string;
  displayName: string;
  clinicDate: Date;
}

/** Injectable dependencies (defaults wire up real config/prisma/Graph). */
export interface ChannelLinkDeps {
  fetchImpl?: typeof fetch;
  getToken?: () => Promise<string>;
  now?: Date;
  groupId?: string | undefined;
  loadClinicDates?: () => Promise<Date[] | null>;
  /** Backoff delay. Injectable so tests do not actually wait. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Total wall-clock budget for resolving the channel list, across ALL attempts.
 *
 * Unchanged from the single-attempt timeout this replaces, and that is the
 * point. The card renders inside <Suspense fallback={null}> on the hub, so a
 * slow resolve does not block the dashboard -- but it does hold a serverless
 * invocation open while the rail sits empty. Giving each retry a fresh
 * full-length timeout would have tripled that for no better outcome, so the
 * attempts share one budget instead: more chances to succeed, same ceiling.
 */
export const GRAPH_TOTAL_BUDGET_MS = 8000;

/**
 * Per-attempt slices, summing to the budget above (with the backoff).
 *
 * Fixed slices rather than "whatever remains", which is the subtle trap here: an
 * attempt that fails INSTANTLY (a network error, not a timeout) consumes none of
 * the budget, so a remaining/attempts-left split hands the next attempt a full
 * share of a budget nothing has spent, and the grants sum past the ceiling. A
 * caught test of exactly that pinned 14.7s against an 8s budget.
 *
 * Two attempts, not three. Every observed production failure hung for the whole
 * 8s, and a hung call is not rescued by a shorter third slice -- it is rescued by
 * getting a second connection at all. A generous first attempt also keeps a
 * merely slow (not hung) Graph from being aborted where it used to succeed.
 */
const GRAPH_ATTEMPT_BUDGETS_MS = [5000, 2850] as const;

/** Backoff between attempts. Deliberately tiny -- it comes out of the budget. */
const GRAPH_RETRY_BACKOFF_MS = 150;

// A found channel link is stable for the whole clinic week: the channel does not
// change until the week rolls over on Sunday, at which point the `dateStr` key
// changes and invalidates the entry anyway. So cache a hit for a week (the key,
// not the clock, is what expires it). A null result -- channel not created yet,
// or a transient Graph/token failure -- is retried soon instead.
const HIT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // a clinic week (dateStr rolls over sooner)
const MISS_TTL_MS = 5 * 60 * 1000; // retry a missing/failed lookup within 5 min

interface CacheEntry {
  dateStr: string;
  /** The teams.clinicGroupId this entry was resolved against. Part of the cache
   *  key so that changing the setting (new academic year, or a corrected wrong
   *  group id) invalidates a warm entry instead of serving the old team's channel
   *  for the rest of the clinic week (audit #138). */
  groupId: string;
  value: ClinicChannelLink | null;
  expiresAt: number;
}

let cache: CacheEntry | null = null;

/** Clear the module-level cache. Exported for test isolation only. */
export function __resetChannelCache(): void {
  cache = null;
}

/** Default clinic-date source: the active term's clinicDates array. */
async function loadActiveTermClinicDates(): Promise<Date[] | null> {
  const term = await prisma.term.findFirst({
    where: { status: "ACTIVE" },
    orderBy: { startDate: "desc" },
    select: { clinicDates: true },
  });
  return term?.clinicDates ?? null;
}

function logChannelError(
  stage: string,
  err: unknown,
  extra: Record<string, unknown> = {}
): void {
  log.error(`[teams/channel-link] ${stage} failed`, errorAttrs(err, { stage, ...extra }));
}

/**
 * Transient Graph failures worth another attempt: a request timeout, a network
 * error, rate limiting, or a 5xx. An auth or permission failure is NOT retried,
 * because the next call returns the same answer and the budget is better spent
 * failing fast.
 */
function isTransient(err: unknown): boolean {
  if (err instanceof GraphStatusError) return err.status === 429 || err.status >= 500;
  // AbortSignal.timeout rejects with a TimeoutError; a fetch network failure
  // surfaces as a TypeError.
  return err instanceof Error && (err.name === "TimeoutError" || err instanceof TypeError);
}

class GraphStatusError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Graph channels list failed: ${status}`);
    this.name = "GraphStatusError";
    this.status = status;
  }
}

/**
 * List a Team's channels, retrying transient failures inside one shared budget.
 *
 * Each attempt is capped at whatever remains, so the caller's total wait is
 * bounded no matter how many attempts run. When too little budget is left for a
 * meaningful attempt, it stops rather than firing a call that is certain to
 * abort. Reports the attempts spent so the caller can log them.
 */
async function listGraphChannels(
  url: string,
  token: string,
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
  startedAt: number
): Promise<{ channels: GraphChannel[]; attempts: number }> {
  let lastErr: unknown;

  for (let attempt = 1; attempt <= GRAPH_ATTEMPT_BUDGETS_MS.length; attempt++) {
    // Whichever is smaller: this attempt's slice, or what is actually left of
    // the wall-clock budget. The slice alone bounds the sum; the remaining check
    // also bounds real elapsed time when an earlier attempt ran long.
    const remaining = GRAPH_TOTAL_BUDGET_MS - (Date.now() - startedAt);
    const attemptMs = Math.min(GRAPH_ATTEMPT_BUDGETS_MS[attempt - 1], remaining);
    if (attemptMs <= 0) break;

    try {
      const res = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(attemptMs),
        // Surfaces the per-attempt budget for the test that pins the ceiling.
        // Ignored by fetch, which discards unknown init keys.
        __timeoutMs: attemptMs,
      } as RequestInit);
      if (!res.ok) throw new GraphStatusError(res.status);
      const json = (await res.json()) as { value?: GraphChannel[] };
      return { channels: json.value ?? [], attempts: attempt };
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || attempt === GRAPH_ATTEMPT_BUDGETS_MS.length) break;
      await sleep(GRAPH_RETRY_BACKOFF_MS);
    }
  }

  throw lastErr ?? new Error("Graph channels list failed");
}

/**
 * Resolve the current clinic week's Teams channel link, or null when it cannot
 * be determined (unconfigured, not connected, no active term, channel missing,
 * or any Graph error). Never throws.
 */
export async function getCurrentClinicChannelLink(
  deps: ChannelLinkDeps = {}
): Promise<ClinicChannelLink | null> {
  const {
    fetchImpl = fetch,
    getToken = getAccessToken,
    now = new Date(),
    groupId,
    loadClinicDates = loadActiveTermClinicDates,
    sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = deps;

  const resolvedGroupId = groupId ?? (await getSetting<string>("teams.clinicGroupId"));
  if (!resolvedGroupId) return null;

  let clinicDates: Date[] | null;
  try {
    clinicDates = await loadClinicDates();
  } catch (err) {
    logChannelError("load clinic dates", err);
    return null;
  }
  if (!clinicDates || clinicDates.length === 0) return null;

  const clinicDate = selectCurrentClinicDate(clinicDates, now);
  if (!clinicDate) return null;
  const dateStr = formatClinicDate(clinicDate);

  // Serve from cache when the week, group id, and TTL still hold (caches null
  // misses too). resolvedGroupId is part of the key so a settings change is not
  // masked by a warm entry for the same clinic week.
  if (cache && cache.dateStr === dateStr && cache.groupId === resolvedGroupId && now.getTime() < cache.expiresAt) {
    return cache.value;
  }

  let value: ClinicChannelLink | null = null;
  let attempts = 0;
  const startedAt = Date.now();
  try {
    const token = await getToken();
    // Graph returns up to ~200 channels in one unpaged response. A clinic Team
    // accrues ~one channel per week, so a single page covers years; we do not
    // page. If a Team ever exceeds ~200 channels, this would need @odata.nextLink
    // handling to stay reliable.
    const url = `https://graph.microsoft.com/v1.0/teams/${encodeURIComponent(
      resolvedGroupId
    )}/channels`;
    const listed = await listGraphChannels(url, token, fetchImpl, sleep, startedAt);
    attempts = listed.attempts;
    const channel = matchChannel(listed.channels, dateStr);
    if (channel?.webUrl) {
      value = {
        webUrl: channel.webUrl,
        displayName: channel.displayName,
        clinicDate,
      };
    }
  } catch (err) {
    // Name the clinic week and the attempts spent. The previous log carried
    // neither, so a recurrence could not be tied to a channel or told apart from
    // a single flaky call -- which is exactly why the production occurrences
    // could not be counted.
    logChannelError("resolve channel", err, {
      clinicDate: dateStr,
      attempts: attempts || GRAPH_ATTEMPT_BUDGETS_MS.length,
      elapsedMs: Date.now() - startedAt,
    });
    value = null;
  }

  cache = { dateStr, groupId: resolvedGroupId, value, expiresAt: now.getTime() + (value ? HIT_TTL_MS : MISS_TTL_MS) };
  return value;
}
