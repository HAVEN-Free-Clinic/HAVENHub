"use client";

/**
 * A server-sent event subscription that survives the ways one actually fails.
 *
 * Lifted out of the schedule Builder (modules/schedule/components/builder-board),
 * which learned every rule below the hard way, when a second surface needed the
 * same connection: the training check-in door, where two staffers on two laptops
 * work one queue and each has to see the other's check-ins.
 *
 * The Builder still carries its own copy. It is not wired through here because
 * its stream handling has no test coverage at all -- builder-grid.test.tsx says
 * outright that it renders without the provider to avoid dragging in an
 * EventSource -- and rewiring an untested reconnect path was not worth doing
 * blind inside an unrelated change. It should adopt this; that is a deliberate
 * follow-up, not an oversight.
 *
 * What the raw EventSource gets wrong, and this fixes:
 *
 *   - Its own retry. A browser left alone retries a connection that fails BEFORE
 *     any data arrives almost immediately and forever, which against a stream
 *     that is down (or blocked by an extension) is several requests a second for
 *     as long as the page is open. This closes the socket and backs off.
 *   - Planned rollovers. A serverless function cannot run forever, so the server
 *     closes the stream just short of its lifetime and says `bye` first. That is
 *     a reconnect, not an error, so it must not flash a warning at the operator
 *     every few minutes.
 *   - Transient blips. `reconnecting` is reported only once a drop has LASTED,
 *     for the same reason.
 *   - Background tabs. A hidden tab holding a function open costs money and
 *     delivers nothing anybody is looking at; dropping it and reopening on return
 *     catches up in one snapshot, because the reconnect replays the last revision
 *     this client saw as Last-Event-ID.
 */

import { useEffect, useRef, useState } from "react";

/** First reconnect delay after the stream drops; doubles up to MAX_RETRY_MS. */
const FIRST_RETRY_MS = 3_000;
const MAX_RETRY_MS = 30_000;
/** How long a drop must last before it is worth telling the user about. */
const OFFLINE_AFTER_MS = 6_000;

export type LiveState = "off" | "connecting" | "live" | "reconnecting";

export function useEventStream<T extends { revision: string }>(opts: {
  /**
   * Builds the stream URL from the last revision this client saw, so a reconnect
   * that finds nothing changed transfers nothing. Called on every open, and must
   * be stable (wrap in useCallback) or the stream reopens on each render.
   */
  url: (revision: string) => string;
  /** The SSE `event:` name carrying a snapshot. */
  event: string;
  /** Applied to each snapshot. Must be stable, for the same reason as `url`. */
  onSnapshot: (snapshot: T) => void;
  /** False tears the stream down: a viewer who may not read it, or a test. */
  enabled?: boolean;
}): LiveState {
  const { url, event, onSnapshot, enabled = true } = opts;
  // Connection status only. "off" is DERIVED from `enabled` at the bottom rather
  // than written here, because setting state from inside the effect that reads
  // `enabled` is a cascading render for a value already known during render.
  const [connection, setConnection] = useState<LiveState>("connecting");
  // In a ref, not state: it changes on every snapshot and is read only when
  // opening a connection, so re-rendering for it would be pure waste -- and
  // putting it in the effect's deps would reopen the stream on every message.
  const revisionRef = useRef("");
  const onSnapshotRef = useRef(onSnapshot);
  // Synced in an effect, not during render: a ref written while rendering is
  // torn under concurrent rendering, and this one is only ever read from an
  // event handler. Declared BEFORE the stream effect so React's in-order run
  // has it current before any connection can deliver a frame.
  useEffect(() => {
    onSnapshotRef.current = onSnapshot;
  }, [onSnapshot]);

  useEffect(() => {
    if (!enabled) return;

    let source: EventSource | null = null;
    let offlineTimer: ReturnType<typeof setTimeout> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let backoff = FIRST_RETRY_MS;

    function open() {
      if (source) return;
      const es = new EventSource(url(revisionRef.current));
      source = es;

      es.onopen = () => {
        if (offlineTimer) {
          clearTimeout(offlineTimer);
          offlineTimer = null;
        }
        backoff = FIRST_RETRY_MS;
        setConnection("live");
      };

      es.addEventListener(event, (e) => {
        try {
          const snapshot = JSON.parse((e as MessageEvent<string>).data) as T;
          revisionRef.current = snapshot.revision;
          onSnapshotRef.current(snapshot);
        } catch {
          // A truncated frame is not worth tearing the connection down for; the
          // next snapshot is a full one and supersedes it.
        }
      });

      // The server closes just short of its function lifetime. Reconnect at once
      // rather than waiting out the retry interval and blinking the indicator.
      es.addEventListener("bye", () => {
        close();
        backoff = FIRST_RETRY_MS;
        open();
      });

      es.onerror = () => {
        close();
        retryTimer = setTimeout(open, backoff);
        backoff = Math.min(backoff * 2, MAX_RETRY_MS);
        if (!offlineTimer) {
          offlineTimer = setTimeout(() => {
            offlineTimer = null;
            setConnection("reconnecting");
          }, OFFLINE_AFTER_MS);
        }
      };
    }

    function close() {
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      source?.close();
      source = null;
    }

    /** close(), plus forgetting that we were ever worried about it. */
    function stop() {
      if (offlineTimer) {
        clearTimeout(offlineTimer);
        offlineTimer = null;
      }
      close();
    }

    function onVisibility() {
      if (document.visibilityState === "hidden") {
        stop();
        setConnection("connecting");
      } else {
        backoff = FIRST_RETRY_MS;
        open();
      }
    }

    if (document.visibilityState !== "hidden") open();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
    };
  }, [enabled, url, event]);

  return enabled ? connection : "off";
}
