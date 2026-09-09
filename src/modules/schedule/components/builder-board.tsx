"use client";

/**
 * The interactive Schedule Builder's shared state.
 *
 * One store behind both boards (the grid and the Day view), because they render
 * the same assignments and a click in either has to move both. It owns three
 * things:
 *
 *   1. the board -- dateKey -> personId -> assignment -- seeded from the server
 *      render and thereafter maintained here;
 *   2. writes -- applied to the board immediately, then POSTed, then reconciled
 *      against the snapshot the server hands back;
 *   3. the live connection -- an EventSource carrying other people's changes.
 *
 * Why the board is not re-seeded from props after the first mount: the client
 * is routinely AHEAD of the server render (a click that has not been reflected
 * back yet), so trusting a re-rendered prop would flicker an edit back out. The
 * stream and each write's own response are the only things that overwrite it.
 *
 * Nothing here navigates. That is the point: the old builder posted a form and
 * redirected to its own URL on every click, which re-ran the whole page load and
 * threw away both the page scroll and the grid's horizontal scroll.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { Alert } from "@/platform/ui/alert";
import { Button } from "@/platform/ui/button";
import { cx } from "@/platform/ui/cx";
import type {
  BuilderAssignmentEntry,
  BuilderAssignments,
  ShiftTag,
} from "@/modules/schedule/services/builder";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ShiftRole = "VOLUNTEER" | "SHADOW" | "DIRECTOR";

/** Identity for an optimistic assignment, for people who have no row yet. */
export type BoardPerson = {
  name: string;
  verifiedLanguages: string[];
  licensedRN: boolean;
};

export type LiveState = "connecting" | "live" | "reconnecting" | "off";

export type BoardApi = {
  assignments: BuilderAssignments;
  editable: boolean;
  /** True while a write against this cell is in flight. */
  isBusy: (dateKey: string, personId: string) => boolean;
  assign: (dateKey: string, personId: string, role: ShiftRole) => void;
  unassign: (dateKey: string, personId: string, reason?: string) => void;
  toggleTag: (dateKey: string, personId: string, tag: ShiftTag) => void;
  /** The last write that failed, for the banner. Null when everything is fine. */
  error: string | null;
  dismissError: () => void;
  live: LiveState;
};

const BoardContext = createContext<BoardApi | null>(null);

/**
 * The board, from the surrounding provider.
 *
 * `override` exists for tests and for rendering a board outside a provider: the
 * grid and the Day view are pure functions of a BoardApi, and a unit test should
 * be able to hand them a stub rather than stand up a router, a stream and a
 * fetch. It is read unconditionally so the hook order never changes.
 */
export function useBuilderBoard(override?: BoardApi): BoardApi {
  const ctx = useContext(BoardContext);
  const board = override ?? ctx;
  if (!board) {
    throw new Error("useBuilderBoard must be used inside <BuilderBoardProvider>");
  }
  return board;
}

// ---------------------------------------------------------------------------
// Pure board edits
// ---------------------------------------------------------------------------

/** First reconnect delay after the stream drops; doubles up to MAX_RETRY_MS. */
const FIRST_RETRY_MS = 3_000;
const MAX_RETRY_MS = 30_000;
/** How long the stream may be down before the page says so. */
const OFFLINE_AFTER_MS = 6_000;

const NO_TAGS = {
  triage: false,
  walkin: false,
  cc: false,
  remote: false,
  specialty: false,
} as const;

/**
 * Copy-on-write down the two levels the edit touches. The grid renders a cell
 * per (date, person), so replacing the whole board object on every keystroke of
 * clicking would be fine correctness-wise but re-renders every cell; this keeps
 * untouched dates referentially stable.
 */
function withAssignment(
  board: BuilderAssignments,
  dateKey: string,
  personId: string,
  entry: BuilderAssignmentEntry | null,
): BuilderAssignments {
  const day = { ...(board[dateKey] ?? {}) };
  if (entry === null) {
    delete day[personId];
  } else {
    day[personId] = entry;
  }
  return { ...board, [dateKey]: day };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

type ProviderProps = {
  termId: string;
  departmentId: string;
  /** False for an archived term: every write path renders inert. */
  editable: boolean;
  initialAssignments: BuilderAssignments;
  /** Board stamp the page was rendered with, so a reconnect that finds nothing
   *  changed sends nothing. */
  initialRevision: string;
  /**
   * Name and capability flags for everyone who can be assigned, so an optimistic
   * cell renders the same badges the server would have sent back. Missing ids
   * fall back to a bare name.
   */
  people: Record<string, BoardPerson>;
  /** Off for an archived term: nothing can change, so nothing needs watching. */
  live?: boolean;
  /**
   * Whether a change here makes the SERVER-rendered part of the page stale.
   *
   * True for the Day view, which sits beside a clearance banner, conflict
   * badges, capacity metrics, a readiness panel and a shift-email list, all
   * derived server-side from these same assignments. False for the grid, where
   * the page holds nothing but the board itself and a refresh would be a whole
   * page render bought for nothing -- which matters most exactly there, since
   * the grid is where a director clicks twenty cells in a row.
   */
  refreshOnChange?: boolean;
  children: ReactNode;
};

export function BuilderBoardProvider({
  termId,
  departmentId,
  editable,
  initialAssignments,
  initialRevision,
  people,
  live: liveEnabled = true,
  refreshOnChange = true,
  children,
}: ProviderProps) {
  const router = useRouter();
  const [assignments, setAssignments] = useState<BuilderAssignments>(initialAssignments);
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<LiveState>(liveEnabled ? "connecting" : "off");

  // The board the stream and each write reconcile against. Kept in a ref as well
  // as state because the async paths below read it outside a render.
  const revisionRef = useRef(initialRevision);
  const inFlightRef = useRef(0);
  // A snapshot that arrived while a write was still in flight. Applying it then
  // would undo the optimistic edit the write has not confirmed yet, so it waits.
  const deferredRef = useRef<{ revision: string; assignments: BuilderAssignments } | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Held in a ref rather than read from the prop inside `assign`: the page
  // rebuilds this map on every server render (router.refresh included), and
  // depending on it would rebuild every callback and re-render every cell.
  const peopleRef = useRef(people);
  useEffect(() => {
    peopleRef.current = people;
  }, [people]);

  /**
   * Re-render the server half of the page in the background.
   *
   * The boards are client-owned now, but the panels AROUND them are not: the
   * clearance banner, the cross-department conflict badges, the capacity metrics
   * and the readiness panel are all derived server-side from these same
   * assignments, and only the server can compute them (conflicts, for one, read
   * other departments this viewer may not even manage).
   *
   * router.refresh keeps scroll and keeps this component mounted, so it is
   * nothing like the redirect this replaced. Debounced so a run of clicks costs
   * one refresh at the end rather than one per click, and skipped entirely where
   * the page has no server-derived panel to refresh (see refreshOnChange).
   */
  const scheduleRefresh = useCallback(() => {
    if (!refreshOnChange) return;
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      router.refresh();
    }, 1_200);
  }, [router, refreshOnChange]);

  useEffect(
    () => () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    },
    [],
  );

  /** Take a remote snapshot, unless a local write is still unconfirmed. */
  const acceptSnapshot = useCallback(
    (revision: string, board: BuilderAssignments) => {
      if (inFlightRef.current > 0) {
        deferredRef.current = { revision, assignments: board };
        return;
      }
      deferredRef.current = null;
      revisionRef.current = revision;
      setAssignments(board);
    },
    [],
  );

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  /**
   * Re-read the board from the server. Used when a write is rejected with
   * nothing newer to fall back on: the optimistic change has to go, and only the
   * server knows what is actually there.
   */
  const resync = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/schedule/builder?term=${encodeURIComponent(termId)}&dept=${encodeURIComponent(departmentId)}`,
        { cache: "no-store" },
      );
      if (!res.ok) return;
      const json = (await res.json()) as { revision: string; assignments: BuilderAssignments };
      acceptSnapshot(json.revision, json.assignments);
    } catch {
      // Leave the board as it is; the stream reconciles when it comes back.
    }
  }, [termId, departmentId, acceptSnapshot]);

  const mutate = useCallback(
    (
      dateKey: string,
      personId: string,
      optimistic: (board: BuilderAssignments) => BuilderAssignments,
      body: Record<string, unknown>,
    ) => {
      if (!editable) return;
      const cellKey = `${dateKey}:${personId}`;

      setAssignments(optimistic);
      setBusy((prev) => new Set(prev).add(cellKey));
      inFlightRef.current += 1;

      void (async () => {
        let failure: string | null = null;
        let snapshot: { revision: string; assignments: BuilderAssignments } | null = null;
        try {
          const res = await fetch("/api/schedule/builder", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ termId, departmentId, dateKey, personId, ...body }),
            cache: "no-store",
          });
          if (res.ok) {
            snapshot = (await res.json()) as {
              revision: string;
              assignments: BuilderAssignments;
            };
          } else if (res.status === 503) {
            // A database blip rather than a rejection, so this is worth naming
            // separately from "could not be saved" -- the director should try
            // again in a moment, not go looking for what they did wrong.
            //
            // It must NOT promise more than that. This used to read "Saved
            // locally but the server is unreachable. Retrying in the
            // background." Both halves were false:
            //
            //  - Nothing retries. The only timers in this file (FIRST_RETRY_MS /
            //    MAX_RETRY_MS / retryTimer) reconnect the EventSource; no write
            //    is ever re-sent.
            //  - It is not saved locally either. This path falls through to the
            //    rollback below like every other failure, and the edit is
            //    discarded -- by the deferred snapshot, by resync(), or, if
            //    resync's own fetch fails in the same outage, by acceptSnapshot
            //    the moment the stream reconnects.
            //
            // So a director was told a shift was staffed, watched the cell
            // revert, and had a banner still saying it was saved -- a banner
            // that only clears on Dismiss. Building a real retry queue is a
            // separate piece of work; until it exists the message says what
            // actually happened.
            failure = "Not saved: the server is briefly unreachable. Try that change again.";
          } else {
            const payload = (await res.json().catch(() => null)) as { error?: string } | null;
            failure = payload?.error ?? "That change could not be saved.";
          }
        } catch {
          failure = "That change could not be saved. Check your connection.";
        } finally {
          inFlightRef.current -= 1;
          setBusy((prev) => {
            const next = new Set(prev);
            next.delete(cellKey);
            return next;
          });
        }

        if (snapshot) {
          // The server's own answer is authoritative and already includes this
          // write, so it supersedes anything the stream deferred meanwhile.
          deferredRef.current = null;
          if (inFlightRef.current === 0) {
            revisionRef.current = snapshot.revision;
            setAssignments(snapshot.assignments);
          }
          setError(null);
          scheduleRefresh();
          return;
        }

        setError(failure);
        if (inFlightRef.current === 0) {
          const deferred = deferredRef.current;
          if (deferred) {
            // Nothing of ours is outstanding any more, so the last thing the
            // stream saw is the truth -- which also rolls back the rejected edit.
            deferredRef.current = null;
            revisionRef.current = deferred.revision;
            setAssignments(deferred.assignments);
          } else {
            // Rejected with nothing newer to fall back on: re-read the board so
            // the optimistic change does not linger as a lie.
            void resync();
          }
        }
      })();
    },
    [editable, termId, departmentId, scheduleRefresh, resync],
  );

  const assign = useCallback(
    (dateKey: string, personId: string, role: ShiftRole) => {
      const person = peopleRef.current[personId] ?? {
        name: "",
        verifiedLanguages: [],
        licensedRN: false,
      };
      mutate(
        dateKey,
        personId,
        (board) =>
          withAssignment(board, dateKey, personId, {
            role,
            // A fresh row is created with every tag false (setAssignment), and an
            // existing row keeps the tags it has when only its role changes.
            tags: { ...NO_TAGS, ...board[dateKey]?.[personId]?.tags },
            person: board[dateKey]?.[personId]?.person ?? person,
          }),
        { kind: "assign", role },
      );
    },
    [mutate],
  );

  const unassign = useCallback(
    (dateKey: string, personId: string, reason?: string) => {
      mutate(
        dateKey,
        personId,
        (board) => withAssignment(board, dateKey, personId, null),
        { kind: "unassign", ...(reason ? { reason } : {}) },
      );
    },
    [mutate],
  );

  const toggleTag = useCallback(
    (dateKey: string, personId: string, tag: ShiftTag) => {
      mutate(
        dateKey,
        personId,
        (board) => {
          const current = board[dateKey]?.[personId];
          if (!current) return board;
          return withAssignment(board, dateKey, personId, {
            ...current,
            tags: { ...current.tags, [tag]: !current.tags[tag] },
          });
        },
        { kind: "tag", tag },
      );
    },
    [mutate],
  );

  // -------------------------------------------------------------------------
  // Live stream
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!liveEnabled) return;

    let source: EventSource | null = null;
    let offlineTimer: ReturnType<typeof setTimeout> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let backoff = FIRST_RETRY_MS;

    function open() {
      if (source) return;
      const url =
        `/api/schedule/builder/stream?term=${encodeURIComponent(termId)}` +
        `&dept=${encodeURIComponent(departmentId)}` +
        `&rev=${encodeURIComponent(revisionRef.current)}`;
      const es = new EventSource(url);
      source = es;

      es.onopen = () => {
        if (offlineTimer) {
          clearTimeout(offlineTimer);
          offlineTimer = null;
        }
        backoff = FIRST_RETRY_MS;
        setLive("live");
      };

      es.addEventListener("board", (event) => {
        try {
          const json = JSON.parse((event as MessageEvent<string>).data) as {
            revision: string;
            assignments: BuilderAssignments;
          };
          acceptSnapshot(json.revision, json.assignments);
          // Someone else moved a shift: the server-rendered panels around the
          // board are now stale for the same reason our own writes make them
          // stale.
          scheduleRefresh();
        } catch {
          // A truncated frame is not worth tearing the connection down for; the
          // next snapshot is a full board and supersedes it.
        }
      });

      // The server closes the stream just short of its function lifetime. That is
      // a planned rollover, so reconnect at once instead of waiting out the
      // retry interval and blinking the indicator.
      es.addEventListener("bye", () => {
        close();
        backoff = FIRST_RETRY_MS;
        open();
      });

      es.onerror = () => {
        // Reconnect on our own schedule rather than EventSource's.
        //
        // A browser left to itself retries a connection that fails BEFORE any
        // data arrives almost immediately and forever -- which against a stream
        // that is down (or blocked) is a request storm, several a second, for as
        // long as the page is open. Closing the socket and backing off turns
        // that into a handful of attempts a minute.
        close();
        retryTimer = setTimeout(open, backoff);
        backoff = Math.min(backoff * 2, MAX_RETRY_MS);
        // Only call it a problem if it stays down, so a routine stream rollover
        // does not flash a warning at everyone every few minutes.
        if (!offlineTimer) {
          offlineTimer = setTimeout(() => {
            offlineTimer = null;
            setLive("reconnecting");
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

    // A background tab holds a function open for nothing. Dropping the stream
    // when the tab is hidden and re-opening on return costs one reconnect and
    // catches up in a single snapshot, because the reconnect carries the last
    // revision this client saw.
    function onVisibility() {
      if (document.visibilityState === "hidden") {
        stop();
        setLive("connecting");
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
  }, [liveEnabled, termId, departmentId, acceptSnapshot, scheduleRefresh]);

  const isBusy = useCallback(
    (dateKey: string, personId: string) => busy.has(`${dateKey}:${personId}`),
    [busy],
  );

  const value = useMemo<BoardApi>(
    () => ({
      assignments,
      editable,
      isBusy,
      assign,
      unassign,
      toggleTag,
      error,
      dismissError: () => setError(null),
      live,
    }),
    [assignments, editable, isBusy, assign, unassign, toggleTag, error, live],
  );

  return <BoardContext.Provider value={value}>{children}</BoardContext.Provider>;
}

// ---------------------------------------------------------------------------
// Status strip
// ---------------------------------------------------------------------------

/**
 * The board's two pieces of ambient feedback: whether the live connection is up,
 * and the last write that failed.
 *
 * Both belong to the board rather than to either view, and both are things the
 * old builder did not need to say -- a full page reload after every click was its
 * own receipt. Now that clicks are silent, "saved" has to be visible some other
 * way, and so does "not saved".
 */
export function BuilderBoardStatus() {
  const { error, dismissError, live } = useBuilderBoard();

  const liveLabel =
    live === "live"
      ? "Live"
      : live === "reconnecting"
        ? "Reconnecting"
        : live === "connecting"
          ? "Connecting"
          : null;

  return (
    <>
      {error && (
        <Alert tone="error" className="mb-4">
          <span className="flex flex-wrap items-center justify-between gap-3">
            <span>{error}</span>
            <Button type="button" variant="outline" size="sm" onClick={dismissError}>
              Dismiss
            </Button>
          </span>
        </Alert>
      )}
      {liveLabel && (
        <p className="mb-3 flex items-center gap-1.5 text-xs text-muted-foreground">
          <span
            aria-hidden="true"
            className={cx(
              "inline-block h-2 w-2 rounded-full",
              live === "live" ? "bg-success" : "bg-warning",
            )}
          />
          {live === "live"
            ? "Live. Changes save as you click, and other directors' changes appear here."
            : live === "connecting"
              ? "Connecting to live updates. Your changes still save as you click."
              : "Reconnecting to live updates. Your changes still save as you click."}
        </p>
      )}
    </>
  );
}
