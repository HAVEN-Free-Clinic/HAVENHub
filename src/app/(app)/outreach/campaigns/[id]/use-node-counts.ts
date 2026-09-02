"use client";

import { useEffect, useRef, useState } from "react";
import type { Audience } from "@/platform/email/audience/types";
import { audienceStructureKey } from "./node-paths";

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
 * Three behaviours beyond the debounce, all about what the sender sees while a
 * request is in the air:
 *
 * - After a pure VALUE edit the previous counts stay on screen, flagged
 *   `stale`, rather than blanking. Blanking would make every row in the tree
 *   flicker on each keystroke; a row with no count renders nothing at all (see
 *   NodeCount in audience-builder.tsx), so the tree would visibly lose and
 *   regain its numbers on every character typed.
 * - After a STRUCTURAL edit the map is dropped instead, because a retained
 *   count would then be attached to the wrong clause: paths are positional, and
 *   a group's connective decides how its count is labelled. See
 *   audienceStructureKey for the misreadings this prevents.
 *
 *   That drop is a RENDER-PHASE derivation, not an effect: each answer is
 *   stamped with the structure it was compiled under, and a stamp that no
 *   longer matches yields `{}`. Dropping it in the effect instead left a window
 *   of exactly one paint, because React commits the render carrying the new
 *   connective and the OLD counts before running passive effects, so a frame
 *   could show "Matches 5 people (everyone matching none of these)" against a
 *   number compiled as an intersection. Tests cannot see that window at all
 *   (act() flushes passive effects before returning), which is precisely why it
 *   is closed structurally rather than guarded by one.
 * - Responses are matched against a request sequence number and a LATER answer
 *   always wins. A server action cannot be aborted, so a slow early request is
 *   still in flight when a faster later one lands; without this guard it would
 *   arrive second and repaint numbers for a tree the sender has already changed.
 *
 * `action` is optional: the scope editor renders the same builder with no
 * campaign to count against, and the campaign editor passes one only while the
 * Audience tab is showing. Its PRESENCE is therefore an input the effect must
 * react to, even though its IDENTITY is not (see `enabled` below).
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
  const structure = audienceStructureKey(audience);

  // The last SUCCESSFUL answer, stamped with the tree it was computed for.
  const [answer, setAnswer] = useState<
    { counts: NodeCounts; structure: string; key: string } | null
  >(null);
  // The last tree that got a definitive answer, success or failure. Separate
  // from `answer` so a failed request can end the in-flight state without
  // discarding the numbers still on screen.
  const [settledKey, setSettledKey] = useState<string | null>(null);

  // The action's IDENTITY is held in a ref and deliberately kept out of the
  // deps: it arrives as a prop, and depending on it would re-request on any
  // parent re-render that handed down a new reference. Its PRESENCE is a
  // separate question and IS a dependency. Conflating the two is what broke the
  // one path every sender takes: the campaign editor supplies the action only
  // on the Audience tab, switching tabs is a soft nav that reconciles rather
  // than remounting, and the tree does not change across it, so with only
  // [key, structure] the effect never re-ran and no request was ever issued.
  const actionRef = useRef(action);
  useEffect(() => {
    actionRef.current = action;
  }, [action]);
  const enabled = action !== undefined;

  // Monotonic request id. Only the newest request may write to state.
  const latestRequest = useRef(0);

  useEffect(() => {
    // No action means no counting at all: the scope editor, or the campaign
    // editor on a tab other than Audience.
    if (!enabled) return;
    const requestId = ++latestRequest.current;
    const timer = setTimeout(() => {
      const run = actionRef.current;
      if (!run) return;
      run(JSON.parse(key) as Audience).then(
        (next) => {
          if (requestId !== latestRequest.current) return;
          // Stamped with the tree this request was issued for, which is what
          // lets the two derivations below decide whether it still describes
          // what is on screen.
          setAnswer({ counts: next, structure, key });
          setSettledKey(key);
        },
        () => {
          // A failed count leaves the last good numbers in place rather than
          // wiping them, but must not leave the tree dimmed forever.
          if (requestId === latestRequest.current) setSettledKey(key);
        },
      );
    }, NODE_COUNT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [key, structure, enabled]);

  // Both derived during render rather than pushed from the effect. Nothing is
  // set synchronously inside the effect at all, which is what keeps the two
  // windows below closed AND what the set-state-in-effect lint rule is asking
  // for: a value React can compute from what it already has should not be
  // round-tripped through an extra render.
  //
  // counts: no frame can paint a number beside a clause it was not compiled
  // for, because a stamp that no longer matches yields {} in the same render
  // that introduced the mismatch.
  //
  // stale: the provisional cue appears in the same commit as the edit, rather
  // than one paint later. Keyed on the serialised tree, so the one gap is an
  // exact revert to a tree that already settled (type, fail, edit, undo): the
  // retry flies without a dim. Cosmetic, on a failure path, and preferable to
  // reintroducing an effect that writes state.
  const counts = answer !== null && answer.structure === structure ? answer.counts : {};
  const stale = enabled && settledKey !== key;

  return { counts, stale };
}
