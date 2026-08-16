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
 * When the live lookup fails we serve the last link we successfully resolved for
 * the SAME clinic week rather than hiding the card. The week's channel does not
 * change once it exists, so a saved copy stays correct until the week rolls over
 * (and the key rolls with it). That fallback is durable -- a Setting row -- and
 * deliberately so: the module cache below does not survive a serverless cold
 * start, which is exactly when the lookup is slowest.
 *
 * A failure with no saved link still degrades to null, so the dashboard hides
 * the card rather than throwing.
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
  /**
   * Durable last-known-good store, keyed by group id + clinic week. Lets a
   * failed resolve fall back to a link an earlier invocation saved, which the
   * module cache cannot do across a serverless cold start. Injectable so the
   * resolver tests never touch the database.
   */
  loadLastGood?: (groupId: string, dateStr: string) => Promise<ClinicChannelLink | null>;
  saveLastGood?: (groupId: string, dateStr: string, link: ClinicChannelLink) => Promise<void>;
  /** Drop the saved link once a live resolve proves it no longer matches. */
  clearLastGood?: (groupId: string, dateStr: string) => Promise<void>;
  /**
   * Durable consecutive-failure counter, so a Graph that is down stops costing a
   * full budget on every cold instance. Injectable for the same reason the
   * last-known-good store is: the resolver tests must not touch the database.
   */
  loadFailure?: () => Promise<StoredFailure | null>;
  recordFailure?: (now: Date) => Promise<void>;
  clearFailure?: () => Promise<void>;
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

/**
 * Durable last-known-good link, kept in one reused Setting row -- the same
 * key/value-table-as-runtime-state pattern the cron heartbeat already uses, so
 * this needs no schema change. One row is enough: only one clinic week is ever
 * current, and the stored group id + week are checked on read, so a stale row
 * from a past week (or a repointed team) is simply ignored.
 *
 * Not registered in the settings registry on purpose -- it is resolver state,
 * not an admin-editable setting, so it is written and read through prisma
 * directly and never appears in Admin > Settings.
 */
const LAST_GOOD_KEY = "teams.channelLinkLastGood";

/**
 * Durable "Graph is not answering" marker, same Setting-as-runtime-state pattern.
 *
 * The module cache bounds repeat cost within one warm instance, but a serverless
 * fleet is mostly cold instances, and each one paid the full 8s budget on a call
 * that had not succeeded once in thirty days of production (audit 14, finding 2).
 * That is 8s of function time per cold dashboard render, spent to render nothing,
 * behind a Suspense boundary nobody sees fail.
 *
 * So consecutive failures are counted durably. Past the threshold the resolver
 * stops calling Graph for a cooldown and serves the saved link (or null)
 * immediately. Any success clears it, so a fixed configuration recovers on the
 * first attempt after the cooldown rather than needing a deploy.
 */
const FAILURE_KEY = "teams.channelLinkFailure";

/** Consecutive failures before the resolver starts skipping the Graph call. */
const FAILURE_TRIP_COUNT = 3;

/** How long to skip for once tripped. Short enough that a fix is picked up soon. */
const FAILURE_COOLDOWN_MS = 30 * 60 * 1000;

export interface StoredFailure {
  /** Consecutive failures; reset to 0 by any success. */
  count: number;
  /** ISO string of the most recent failure. */
  at: string;
}

async function loadStoredFailure(): Promise<StoredFailure | null> {
  try {
    const row = await prisma.setting.findUnique({ where: { key: FAILURE_KEY } });
    const stored = row?.value as StoredFailure | null;
    if (!stored || typeof stored.count !== "number" || !stored.at) return null;
    return stored;
  } catch {
    return null;
  }
}

/** Never throws: observability state must not fail a render. */
async function recordStoredFailure(now: Date): Promise<void> {
  try {
    const prev = await loadStoredFailure();
    const value = {
      count: (prev?.count ?? 0) + 1,
      at: now.toISOString(),
    } satisfies StoredFailure;
    await prisma.setting.upsert({
      where: { key: FAILURE_KEY },
      create: { key: FAILURE_KEY, value },
      update: { value },
    });
  } catch {
    // Best-effort.
  }
}

/** Never throws. Cheap no-op when there is nothing to clear. */
async function clearStoredFailure(): Promise<void> {
  try {
    await prisma.setting.deleteMany({ where: { key: FAILURE_KEY } });
  } catch {
    // Best-effort.
  }
}

interface StoredLastGood {
  groupId: string;
  dateStr: string;
  webUrl: string;
  displayName: string;
  /** ISO string: JSON has no Date type. */
  clinicDate: string;
}

/** Read the saved link, but only when it is for this group and clinic week. */
async function loadStoredLastGood(
  groupId: string,
  dateStr: string
): Promise<ClinicChannelLink | null> {
  try {
    const row = await prisma.setting.findUnique({ where: { key: LAST_GOOD_KEY } });
    const stored = row?.value as StoredLastGood | null;
    if (!stored || stored.groupId !== groupId || stored.dateStr !== dateStr) return null;
    if (!stored.webUrl) return null;
    return {
      webUrl: stored.webUrl,
      displayName: stored.displayName,
      clinicDate: new Date(stored.clinicDate),
    };
  } catch {
    // Best-effort: a DB blip just means there is no fallback available, which
    // lands on the same degrade-to-null path as having never saved one.
    return null;
  }
}

/**
 * Drop the saved link. Called when Graph answers and no channel matches this
 * week: whatever is stored is then known-stale, and keeping it would let the NEXT
 * transient failure serve a deep link to a channel that has been renamed or
 * deleted (audit 14, NOTIF-3). Never throws.
 */
async function clearStoredLastGood(groupId: string, dateStr: string): Promise<void> {
  try {
    const row = await prisma.setting.findUnique({ where: { key: LAST_GOOD_KEY } });
    const stored = row?.value as StoredLastGood | null;
    // Only clear OUR group's row; a repointed team's row is already ignored on
    // read and is not ours to delete.
    if (!stored || stored.groupId !== groupId || stored.dateStr !== dateStr) return;
    await prisma.setting.deleteMany({ where: { key: LAST_GOOD_KEY } });
  } catch {
    // Best-effort.
  }
}

/** Persist a freshly resolved link. Never throws -- it must not fail a render. */
async function saveStoredLastGood(
  groupId: string,
  dateStr: string,
  link: ClinicChannelLink
): Promise<void> {
  const value = {
    groupId,
    dateStr,
    webUrl: link.webUrl,
    displayName: link.displayName,
    clinicDate: link.clinicDate.toISOString(),
  } satisfies StoredLastGood;
  try {
    await prisma.setting.upsert({
      where: { key: LAST_GOOD_KEY },
      create: { key: LAST_GOOD_KEY, value },
      update: { value },
    });
  } catch {
    // Best-effort persistence; a failed write only forfeits a future fallback.
  }
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
  /** First 200 chars of Graph's error body, or "" when it could not be read. */
  readonly body: string;
  constructor(status: number, body: string) {
    super(`Graph channels list failed: ${status}${body ? ` -- ${body}` : ""}`);
    this.name = "GraphStatusError";
    this.status = status;
    this.body = body;
  }
}

/**
 * Read Graph's error body without ever letting that read fail the request.
 *
 * A non-2xx used to be reduced to a bare status number, which made the two
 * failures an operator actually has to tell apart look identical in the logs: a
 * 403 for a missing Channel.ReadBasic.All scope and a 403 for a mailbox that is
 * not a member of the Team carry completely different fixes, and Graph explains
 * which in the body every time (audit 14). Truncated because Graph error bodies
 * can be long and this goes to a log line, not a debugger.
 */
async function readErrorBody(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return "";
  }
}

/**
 * List a Team's channels, retrying transient failures inside one shared budget.
 *
 * Each attempt is capped at whatever remains, so the caller's total wait is
 * bounded no matter how many attempts run. When too little budget is left for a
 * meaningful attempt, it stops rather than firing a call that is certain to
 * abort.
 *
 * `stats.attempts` is incremented before each call, so the count survives the
 * throw. It used to be reported only on the success path, which left the FAILURE
 * log -- the only one anybody reads -- printing a hardcoded "attempts=2" whether
 * two attempts ran, one ran, or none did because the budget was already spent.
 * Two rounds of tuning were argued from that constant.
 */
async function listGraphChannels(
  url: string,
  token: string,
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
  startedAt: number,
  stats: { attempts: number }
): Promise<{ channels: GraphChannel[]; truncated: boolean }> {
  let lastErr: unknown;

  for (let attempt = 1; attempt <= GRAPH_ATTEMPT_BUDGETS_MS.length; attempt++) {
    // Whichever is smaller: this attempt's slice, or what is actually left of
    // the wall-clock budget. The slice alone bounds the sum; the remaining check
    // also bounds real elapsed time when an earlier attempt ran long.
    const remaining = GRAPH_TOTAL_BUDGET_MS - (Date.now() - startedAt);
    const attemptMs = Math.min(GRAPH_ATTEMPT_BUDGETS_MS[attempt - 1], remaining);
    if (attemptMs <= 0) break;

    stats.attempts = attempt;
    try {
      const res = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(attemptMs),
        // Surfaces the per-attempt budget for the test that pins the ceiling.
        // Ignored by fetch, which discards unknown init keys.
        __timeoutMs: attemptMs,
      } as RequestInit);
      if (!res.ok) throw new GraphStatusError(res.status, await readErrorBody(res));
      const json = (await res.json()) as {
        value?: GraphChannel[];
        "@odata.nextLink"?: string;
      };
      // We deliberately do not page (see the caller). Reporting whether Graph
      // said there IS another page is what lets "no channel matched" be told
      // apart from "the match is on a page we never asked for" -- which decides
      // whether a saved link may be invalidated.
      return { channels: json.value ?? [], truncated: Boolean(json["@odata.nextLink"]) };
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
 * or any Graph error with no saved link to fall back to). Never throws.
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
    loadLastGood = loadStoredLastGood,
    saveLastGood = saveStoredLastGood,
    clearLastGood = clearStoredLastGood,
    loadFailure = loadStoredFailure,
    recordFailure = recordStoredFailure,
    clearFailure = clearStoredFailure,
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

  // Graph has been failing consecutively: skip the call entirely for a cooldown
  // rather than paying the full budget again on this cold instance. Serve the
  // saved link if there is one, exactly as the failure path would.
  const failure = await loadFailure();
  if (
    failure &&
    failure.count >= FAILURE_TRIP_COUNT &&
    now.getTime() - new Date(failure.at).getTime() < FAILURE_COOLDOWN_MS
  ) {
    let saved: ClinicChannelLink | null = null;
    try {
      saved = await loadLastGood(resolvedGroupId, dateStr);
    } catch {
      // No fallback available.
    }
    cache = {
      dateStr,
      groupId: resolvedGroupId,
      value: saved,
      expiresAt: now.getTime() + (saved ? HIT_TTL_MS : MISS_TTL_MS),
    };
    return saved;
  }

  let value: ClinicChannelLink | null = null;
  let resolvedLive = false;
  const stats = { attempts: 0 };
  const startedAt = Date.now();
  let tokenMs = 0;
  // Which half of the resolve is running. Both halves abort with the SAME
  // TimeoutError -- getAccessToken bounds the Entra refresh with its own 8s
  // AbortSignal, and startedAt is stamped BEFORE it -- so a token refresh that
  // eats the budget used to log as "resolve channel failed, elapsedMs 8001",
  // indistinguishable from Graph itself running long. The stage and the split
  // timings below are what tell those two apart.
  let stage = "acquire token";
  try {
    const token = await getToken();
    tokenMs = Date.now() - startedAt;
    stage = "resolve channel";
    // Graph returns up to ~200 channels in one unpaged response. A clinic Team
    // accrues ~one channel per week, so a single page covers years; we do not
    // page. If a Team ever exceeds ~200 channels, this would need @odata.nextLink
    // handling to stay reliable.
    const url = `https://graph.microsoft.com/v1.0/teams/${encodeURIComponent(
      resolvedGroupId
    )}/channels`;
    const { channels, truncated } = await listGraphChannels(
      url, token, fetchImpl, sleep, startedAt, stats
    );
    const channel = matchChannel(channels, dateStr);
    if (channel?.webUrl) {
      value = {
        webUrl: channel.webUrl,
        displayName: channel.displayName,
        clinicDate,
      };
      resolvedLive = true;
    }

    // The ONLY record that this call can succeed at all. Without it the module
    // logged exclusively on failure, so the real latency that every timeout-budget
    // decision here has been argued from had never once been measured, and a
    // hundred-percent failure rate was indistinguishable from a Team that simply
    // has no channel this week (audit 14, finding 2). One line per completed
    // resolve, at info, and the cache means it is not one per render.
    log.info("[teams/channel-link] resolved", {
      clinicDate: dateStr,
      matched: Boolean(channel?.webUrl),
      channelCount: channels.length,
      truncated,
      attempts: stats.attempts,
      tokenMs,
      graphMs: Date.now() - startedAt - tokenMs,
    });

    // Graph answered, the list was COMPLETE, and nothing matched: the week's
    // channel was renamed or deleted, so a link saved for this same week is now a
    // deep link to a channel that is gone. Drop it, or the next transient failure
    // resurrects it (audit 14, NOTIF-3).
    //
    // Gated on `truncated` deliberately. This call does not follow
    // @odata.nextLink, so on a Team with enough channels to page, "no match" can
    // mean "the match is on a page we never asked for" -- and invalidating a good
    // link on that basis would be strictly worse than keeping it.
    if (!channel?.webUrl && !truncated) {
      await clearLastGood(resolvedGroupId, dateStr);
    }
    await clearFailure();
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    const attrs = {
      clinicDate: dateStr,
      // Real counts now, not a constant: attempts is 0 when the token half
      // consumed the budget and Graph never got a call at all.
      attempts: stats.attempts,
      tokenMs: stage === "acquire token" ? elapsedMs : tokenMs,
      graphMs: stage === "acquire token" ? 0 : elapsedMs - tokenMs,
      elapsedMs,
    };
    // Before hiding the card, fall back to the link a previous invocation saved
    // for this same clinic week. The week's channel does not change once it
    // exists, so the saved copy is still the right answer. Guarded because this
    // function is documented never to throw and it renders a Server Component.
    // Only a TRANSIENT failure earns the fallback. A 401/403/404 is Graph
    // telling us the configuration is wrong or the Team is gone, and serving a
    // saved deep link on top of that hides a problem only an operator can fix
    // while sending people to a channel that may no longer exist (audit 14,
    // NOTIF-3). Timeouts, 429s and 5xx are the cases the fallback was written
    // for: the answer is still correct, we just could not fetch it.
    let fallback: ClinicChannelLink | null = null;
    if (isTransient(err)) {
      try {
        fallback = await loadLastGood(resolvedGroupId, dateStr);
      } catch {
        // No fallback available; fall through to the degrade-to-null path.
      }
    }
    await recordFailure(now);
    if (fallback) {
      // Recovered, so deliberately NOT the "... failed" error line the alerting
      // counts: nobody saw a missing card. The attributes are identical, so the
      // underlying timeout stays fully queryable one severity down. A quiet
      // error stream here means "users stopped seeing it", NOT "Graph stopped
      // timing out" -- watch the `degraded` warn for that.
      log.warn(
        `[teams/channel-link] ${stage} degraded; serving last-known-good link`,
        errorAttrs(err, { stage, ...attrs })
      );
      value = fallback;
    } else {
      logChannelError(stage, err, attrs);
      value = null;
    }
  }

  // Save outside the try so a store failure can never be mistaken for a resolve
  // failure (and so it cannot throw out of a function documented never to).
  if (resolvedLive && value) {
    try {
      await saveLastGood(resolvedGroupId, dateStr, value);
    } catch {
      // Best-effort: losing the save only forfeits a future fallback.
    }
  }

  cache = { dateStr, groupId: resolvedGroupId, value, expiresAt: now.getTime() + (value ? HIT_TTL_MS : MISS_TTL_MS) };
  return value;
}
