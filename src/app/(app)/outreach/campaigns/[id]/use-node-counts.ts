"use client";

import { useEffect, useRef, useState } from "react";
import type { Audience } from "@/platform/email/audience/types";

/**
 * How long the builder waits after the last edit before asking the server for
 * counts.
 *
 * Counting runs on every change to the tree, and a text value changes on every
 * keystroke, so without this a five-letter search term is five round trips, each
 * fanning out over every node. Long enough to swallow typing, short enough that
 * a deliberate change (picking an operator, ticking a checkbox) still feels
 * live.
 */
export const NODE_COUNT_DEBOUNCE_MS = 400;

export type NodeCounts = Record<string, number>;

/**
 * Live per-node match counts for the tree currently being edited.
 *
 * Two behaviours beyond the debounce, both about what the sender sees while a
 * request is in the air:
 *
 * - The previous counts stay on screen, flagged `stale`, rather than blanking.
 *   Blanking would make every row in the tree flicker on each keystroke, and an
 *   empty count reads as "matches nobody", which is the one misreading these
 *   numbers exist to prevent.
 * - Responses are matched against a request sequence number and a LATER answer
 *   always wins. A server action cannot be aborted, so a slow early request is
 *   still in flight when a faster later one lands; without this guard it would
 *   arrive second and repaint numbers for a tree the sender has already changed.
 *
 * `action` is optional: the scope editor renders the same builder with no
 * campaign to count against, and passing nothing simply means no counts.
 */
export function useNodeCounts(
  audience: Audience,
  action?: (audience: Audience) => Promise<NodeCounts>,
): { counts: NodeCounts; stale: boolean } {
  // The audience object is rebuilt on every render, so the effect keys on its
  // serialisation instead: a re-render that did not change the tree must not
  // fire another request, and re-serialising it here is the same JSON.stringify
  // the hidden form input already does on every render.
  const key = JSON.stringify(audience);

  const [counts, setCounts] = useState<NodeCounts>({});
  const [stale, setStale] = useState(false);

  // Held in a ref, and deliberately NOT an effect dependency: the bound server
  // action arrives as a prop, and depending on its identity would re-request on
  // any parent re-render that happened to hand down a new reference.
  const actionRef = useRef(action);
  useEffect(() => {
    actionRef.current = action;
  }, [action]);

  // Monotonic request id. Only the newest request may write to state.
  const latestRequest = useRef(0);

  useEffect(() => {
    if (!actionRef.current) return;
    setStale(true);
    const requestId = ++latestRequest.current;
    const timer = setTimeout(() => {
      const run = actionRef.current;
      if (!run) return;
      run(JSON.parse(key) as Audience).then(
        (next) => {
          if (requestId !== latestRequest.current) return;
          setCounts(next);
          setStale(false);
        },
        () => {
          // A failed count leaves the last good numbers in place rather than
          // wiping them, but must not leave the tree dimmed forever.
          if (requestId === latestRequest.current) setStale(false);
        },
      );
    }, NODE_COUNT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [key]);

  return { counts, stale };
}
