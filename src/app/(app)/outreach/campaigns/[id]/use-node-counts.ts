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
 *   stamped with a monotonic SHAPE EPOCH, and an answer whose epoch is not the
 *   current one yields `{}`. Dropping it in an effect instead left a window of
 *   exactly one paint, because React commits the render carrying the new
 *   connective and the OLD counts before running passive effects, so a frame
 *   could show "Matches 5 people (everyone matching none of these)" against a
 *   number compiled as an intersection. Tests cannot see that window at all
 *   (act() flushes passive effects before returning), which is precisely why it
 *   is closed structurally rather than guarded by one.
 *
 *   The epoch is a COUNTER, not the shape itself, and that distinction is the
 *   whole correctness argument: shapes recur, so comparing an answer's shape to
 *   the current one asks "is this the same shape" when the question is "has the
 *   shape changed since". Remove a clause and add one back, two clicks with
 *   controls that ship today, and a shape-keyed test revives the old map over
 *   completely different clauses. A counter that only advances cannot.
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

  // Everything the effect keys on, as one string: a change here means a new
  // request goes out.
  const trigger = `${enabled ? "on" : "off"}|${key}`;

  /**
   * Two monotonic counters, advanced during render.
   *
   * `epoch` counts SHAPE changes and `gen` counts requests, and both matter for
   * the same reason: the questions being asked are temporal ("has this been
   * superseded since?"), and answering them by comparing CONTENT is wrong
   * because content recurs.
   *
   * `epoch` is what stops a superseded map coming back. Comparing an answer's
   * shape key against the current one asks "is this the same shape", not "has
   * the shape changed since", and two clicks that exist today (Remove, then Add
   * condition) return to a previously answered shape over entirely different
   * clauses. A counter that only ever goes up cannot match an older answer.
   *
   * `gen` is what makes the in-flight cue honest. Keying it on the tree alone
   * said "settled" whenever the tree matched the last answered one, including
   * on the Compose -> Audience return, where re-enabling issues a real request
   * for an unchanged tree. It also missed an exact revert after a failure.
   * Counting requests instead covers both, because a re-fire always advances.
   *
   * Advanced during render (React's documented adjust-state-during-render
   * pattern) rather than in an effect: the value has to be right in the SAME
   * render that changed the tree, or the drop below is a paint late. React
   * re-runs this component immediately, before children render or anything is
   * committed, so nothing intermediate is ever shown. It converges after one
   * extra pass because the branch is false once `tracked` matches.
   */
  const [tracked, setTracked] = useState({ structure, trigger, epoch: 0, gen: 0 });
  const epoch = tracked.structure === structure ? tracked.epoch : tracked.epoch + 1;
  const gen = tracked.trigger === trigger ? tracked.gen : tracked.gen + 1;
  if (epoch !== tracked.epoch || gen !== tracked.gen) {
    setTracked({ structure, trigger, epoch, gen });
  }

  // The last SUCCESSFUL answer, stamped with the shape epoch it was compiled
  // under.
  const [answer, setAnswer] = useState<{ counts: NodeCounts; epoch: number } | null>(null);
  // The newest request that reached a definitive end, success or failure.
  // Separate from `answer` so a failed request can end the in-flight state
  // without discarding the numbers still on screen.
  const [settledGen, setSettledGen] = useState(-1);

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
          // Stamped with the shape epoch this request was issued under, which
          // is what lets the derivation below decide whether it still
          // describes the clauses on screen.
          setAnswer({ counts: next, epoch });
          setSettledGen(gen);
        },
        () => {
          // A failed count leaves the last good numbers in place rather than
          // wiping them, but must not leave the tree dimmed forever.
          if (requestId === latestRequest.current) setSettledGen(gen);
        },
      );
    }, NODE_COUNT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [key, enabled, epoch, gen]);

  // Both derived during render rather than pushed from the effect. Nothing is
  // set synchronously inside the effect at all, which is what keeps both
  // windows below closed AND what the set-state-in-effect lint rule is asking
  // for: a value React can compute from what it already has should not be
  // round-tripped through an extra render.
  //
  // counts: an answer is shown only while the shape it was compiled under is
  // still the current one. Because `epoch` only ever advances, that is a
  // strictly one-way test, so a structurally superseded answer is never
  // displayed again no matter what the tree is edited back into. And because
  // it is derived, the render that supersedes it is the render that drops it:
  // there is no frame in which a number paints beside a clause it was not
  // compiled for, and in particular none in which a NONE label paints beside
  // an intersection-compiled number.
  //
  // stale: true exactly while the newest request has not reached a definitive
  // end, success or failure. Counting requests rather than comparing trees is
  // what makes it right on the two paths where the tree is not what changed:
  // the Compose -> Audience return, which issues a real request for an
  // unchanged tree, and an exact revert to a tree that already settled.
  const counts = answer !== null && answer.epoch === epoch ? answer.counts : {};
  const stale = enabled && settledGen !== gen;

  return { counts, stale };
}
