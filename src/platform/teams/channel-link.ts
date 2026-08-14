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
  /** Delay between Graph retry attempts. Injectable so tests run without waits. */
  sleep?: (ms: number) => Promise<void>;
}

// Per-attempt timeout for the Graph channels call. A channel list is small, so
// a healthy response returns well within this budget; a slower one is aborted
// and retried rather than left to hang.
const GRAPH_TIMEOUT_MS = 8000;
// The Graph call sometimes times out on a transient latency spike. Retry it a
// few times with a short backoff before giving up, so one slow response no
// longer hides the channel card for a whole miss window.
const GRAPH_MAX_ATTEMPTS = 3;
const GRAPH_RETRY_BASE_MS = 300;

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
  log.error(
    `[teams/channel-link] ${stage} failed`,
    errorAttrs(err, { stage, ...extra })
  );
}

/**
 * A transient Graph failure is worth a retry: a request timeout, a network
 * error, rate limiting (429), or a 5xx. An auth or permission error (e.g. 403)
 * is not retried, because a repeat call returns the same result.
 */
function isRetriableError(err: unknown): boolean {
  // AbortSignal.timeout aborts with a TimeoutError; a fetch network failure
  // surfaces as a TypeError. Both are transient.
  return (
    err instanceof Error &&
    (err.name === "TimeoutError" || err.name === "AbortError" || err instanceof TypeError)
  );
}

function isRetriableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * List a Team's channels via Microsoft Graph, retrying transient failures.
 * Each attempt gets a fresh timeout. Throws when every attempt fails, or on the
 * first non-retriable failure.
 */
async function listGraphChannels(
  url: string,
  token: string,
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>
): Promise<GraphChannel[]> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
      });
      if (!res.ok) {
        const err = new Error(`Graph channels list failed: ${res.status}`);
        if (isRetriableStatus(res.status) && attempt < GRAPH_MAX_ATTEMPTS) {
          await sleep(GRAPH_RETRY_BASE_MS * attempt);
          continue;
        }
        throw err;
      }
      const json = (await res.json()) as { value?: GraphChannel[] };
      return json.value ?? [];
    } catch (err) {
      if (isRetriableError(err) && attempt < GRAPH_MAX_ATTEMPTS) {
        await sleep(GRAPH_RETRY_BASE_MS * attempt);
        continue;
      }
      throw err;
    }
  }
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
  try {
    const token = await getToken();
    // Graph returns up to ~200 channels in one unpaged response. A clinic Team
    // accrues ~one channel per week, so a single page covers years; we do not
    // page. If a Team ever exceeds ~200 channels, this would need @odata.nextLink
    // handling to stay reliable.
    const url = `https://graph.microsoft.com/v1.0/teams/${encodeURIComponent(
      resolvedGroupId
    )}/channels`;
    const channels = await listGraphChannels(url, token, fetchImpl, sleep);
    const channel = matchChannel(channels, dateStr);
    if (channel?.webUrl) {
      value = {
        webUrl: channel.webUrl,
        displayName: channel.displayName,
        clinicDate,
      };
    }
  } catch (err) {
    // Include the clinic date so a failure names the channel it was resolving.
    logChannelError("resolve channel", err, { clinicDate: dateStr });
    value = null;
  }

  cache = { dateStr, groupId: resolvedGroupId, value, expiresAt: now.getTime() + (value ? HIT_TTL_MS : MISS_TTL_MS) };
  return value;
}
