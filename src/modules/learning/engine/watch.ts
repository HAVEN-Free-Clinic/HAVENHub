/**
 * The server's rule for how far a learner has watched a video section. Pure.
 *
 * The player refuses to seek past the furthest point reached and pins the
 * playback rate to 1, but the player runs in the learner's browser, so none of
 * that holds against a hand-made request. This does: every heartbeat reports a
 * position, and the stored furthest point may only advance by about as much
 * real time as has passed since the previous heartbeat. Completing a section
 * therefore takes at least as long as the section, however the request is made.
 */

/** Credit per second of wall clock. The 10% headroom absorbs network jitter
 *  between an honest client's 10-second heartbeats; it is also the most a
 *  forger can gain, since slack is not otherwise granted per request. */
export const RATE_SLACK = 1.1;

/** Credit allowed on a section's very first heartbeat, when there is no
 *  previous one to measure elapsed time from. Granted once, never per request,
 *  so spamming heartbeats buys nothing. */
export const FIRST_HEARTBEAT_SLACK_SECONDS = 5;

/** The longest gap one heartbeat can be credited for. Without a cap, opening a
 *  video, waiting an hour with it paused, and then claiming the end would
 *  complete it. The honest player sends a heartbeat every 10 seconds while
 *  playing (and on pause), so this only ever bites a client that stopped
 *  reporting, and even a throttled background tab stays well inside it. */
export const MAX_CREDITED_INTERVAL_SECONDS = 120;

/** How close to the end counts as the end: a video element's last timeupdate
 *  routinely lands a fraction of a second short. */
export const COMPLETE_TOLERANCE_SECONDS = 1;

export type HeartbeatInput = {
  /** The stored furthest point, seconds from the section's start. */
  storedSeconds: number;
  lastHeartbeatAt: Date | null;
  /** What the client says it reached, seconds from the section's start. Untrusted. */
  reportedSeconds: number;
  now: Date;
  /** The section's length in seconds (see sectionLength). */
  length: number;
};

export type HeartbeatResult = { watchedSeconds: number; complete: boolean };

export function acceptHeartbeat(input: HeartbeatInput): HeartbeatResult {
  const { storedSeconds, lastHeartbeatAt, reportedSeconds, now, length } = input;
  const stored = Math.min(Math.max(storedSeconds, 0), length);

  let allowance: number;
  if (lastHeartbeatAt == null) {
    allowance = FIRST_HEARTBEAT_SLACK_SECONDS;
  } else {
    // A clock that runs backwards (or a replayed request) earns nothing.
    const elapsed = Math.max(0, (now.getTime() - lastHeartbeatAt.getTime()) / 1000);
    allowance = Math.min(elapsed, MAX_CREDITED_INTERVAL_SECONDS) * RATE_SLACK;
  }

  const reported = Number.isFinite(reportedSeconds) && reportedSeconds >= 0 ? reportedSeconds : stored;
  // Never backwards: a rewind reports less than the furthest point, which stands.
  let watched = Math.max(stored, Math.min(reported, stored + allowance));
  if (watched >= length - COMPLETE_TOLERANCE_SECONDS) watched = length;
  watched = Math.min(watched, length);
  return { watchedSeconds: watched, complete: watched >= length };
}

/**
 * A section's length in seconds: its explicit end, or else the end of the
 * video, minus its start. Null when that cannot be known (no end and no
 * recorded duration) or the range is empty, which makes the section
 * uncompletable and so keeps the course out of anyone's assignment.
 */
export function sectionLength(
  section: { startSeconds: number; endSeconds: number | null },
  videoDurationSeconds: number | null
): number | null {
  const rawEnd = section.endSeconds ?? videoDurationSeconds;
  if (rawEnd == null) return null;
  const end = videoDurationSeconds != null ? Math.min(rawEnd, videoDurationSeconds) : rawEnd;
  const length = end - section.startSeconds;
  return length > 0 ? length : null;
}

/**
 * Parse an admin-typed time: "45", "1:05", or "1:02:03". Null for blank input
 * (meaning "not set"), undefined for anything malformed so a form can say so.
 */
export function parseTimestamp(raw: string): number | null | undefined {
  const text = raw.trim();
  if (text === "") return null;
  const parts = text.split(":");
  if (parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return undefined;
  const nums = parts.map(Number);
  // Minutes and seconds after the leading unit must be real clock values.
  if (nums.slice(1).some((n) => n >= 60)) return undefined;
  return nums.reduce((total, n) => total * 60 + n, 0);
}

/** Seconds as "m:ss" or "h:mm:ss", truncating fractions. */
export function formatTimestamp(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
