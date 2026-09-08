"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { Button } from "@/platform/ui/button";
import { Input } from "@/platform/ui/input";
import { Badge } from "@/platform/ui/badge";
import { Alert } from "@/platform/ui/alert";
import { Card } from "@/platform/ui/card";
import { EmptyState } from "@/platform/ui/empty-state";
import { outstandingShortLabels } from "@/platform/compliance/outstanding-items";
import { matchCandidates, exactNetIdMatch } from "./check-in-match";
import type {
  CheckInCandidate,
  CheckInResult,
  CheckInTarget,
} from "@/modules/recruitment/services/attendance-events";

/**
 * The door screen.
 *
 * Filters a preloaded candidate list in the browser rather than querying per
 * keystroke: the person holding this is typing fast with a queue in front of
 * them, and a round trip per character is the wrong trade for a list of this
 * size (name, email and netId only). The server is still the authority on every
 * check-in it accepts.
 *
 * The screen never navigates: a redirect per person would throw away the search
 * box and the operator's place in the queue. What it shows instead is the
 * server's own list of who is checked in, plus a result panel for the last tap.
 *
 * That panel is the reason this screen exists rather than a spreadsheet. Someone
 * being checked into training is, right at that moment, the only moment in the
 * term when the clinic has them in the room AND knows exactly what they still
 * owe. The panel is what turns that into a sentence an operator can say out
 * loud before the person walks away.
 *
 * The panel is deliberately NOT a running local log. A server action re-renders
 * the page's server components, so `checkedInNames` already refreshes to include
 * whoever was just tapped; keeping a parallel local list of the same people
 * rendered each of them twice (caught by e2e/event-attendance.spec.ts).
 */
export function CheckInKiosk({
  candidates,
  checkedInNames,
  acceptedCount,
  action,
  allowWalkUps,
}: {
  candidates: CheckInCandidate[];
  /** Names already checked in when the page loaded, newest last. */
  checkedInNames: string[];
  /** Size of the cycle's accepted list, for the progress line. Null with no cycle. */
  acceptedCount: number | null;
  action: (target: CheckInTarget) => Promise<CheckInResult>;
  /** False for a department-scoped director, who may not add unknown people. */
  allowWalkUps: boolean;
}) {
  const [query, setQuery] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<DoorResult | null>(null);
  // Locally checked-in candidate ids, merged with the server's list so a row a
  // staffer just tapped immediately reads as done without a refetch.
  const [justCheckedIn, setJustCheckedIn] = useState<Set<string>>(new Set());
  const [walkUpOpen, setWalkUpOpen] = useState(false);
  // A hand-typed walk-up the server refused to write until somebody says the
  // person belongs here. Held rather than discarded so "Check in anyway" does not
  // make the operator retype an address at a door.
  const [confirming, setConfirming] = useState<{
    name: string;
    email: string;
    message: string;
  } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => matchCandidates(candidates, query), [candidates, query]);

  function focusSearch() {
    // Back to the search box so the next person can be typed without reaching
    // for the mouse.
    searchRef.current?.focus();
  }

  function submit(target: CheckInTarget, fallbackName: string, candidateId?: string) {
    setError(null);
    startTransition(async () => {
      const result = await action(target);
      if (!result.ok) {
        if (result.requiresConfirmation && target.kind === "walkUp") {
          setConfirming({ name: target.name, email: target.email, message: result.message });
          return;
        }
        setError(result.message);
        return;
      }
      if (candidateId) setJustCheckedIn((prev) => new Set(prev).add(candidateId));
      setLastResult({
        name: result.name || fallbackName,
        alreadyCheckedIn: result.alreadyCheckedIn,
        needs: outstandingShortLabels(result.blockerKeys),
        notOnAcceptedList: result.notOnAcceptedList,
        contactEmail: result.contactEmail,
        nudgeQueued: result.nudgeQueued,
      });
      setQuery("");
      setWalkUpOpen(false);
      setConfirming(null);
      focusSearch();
    });
  }

  function submitCandidate(c: CheckInCandidate) {
    submit(
      c.kind === "person"
        ? { kind: "person", personId: c.id }
        : { kind: "applicant", acceptanceId: c.id },
      c.name,
      c.id,
    );
  }

  /**
   * Enter commits, but only when the box holds a whole netId.
   *
   * See check-in-match.ts for why that restriction is the entire safety argument
   * for committing on a keystroke. A partial query or a name falls through to
   * the list, where checking somebody in stays a deliberate click.
   */
  function onSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter" || pending) return;
    e.preventDefault();
    const match = exactNetIdMatch(candidates, query);
    if (match && !isDone(match)) submitCandidate(match);
  }

  function isDone(c: CheckInCandidate) {
    return c.checkedIn || justCheckedIn.has(c.id);
  }

  return (
    <div className="space-y-6">
      {error && (
        <Alert tone="error" role="alert">
          {error}
        </Alert>
      )}

      <Input
        ref={searchRef}
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onSearchKeyDown}
        placeholder="NetID or name"
        aria-label="Search for someone to check in"
        // Larger than the app's default field. This one is read and typed into
        // from a standing position, often at arm's length across a table.
        className="h-14 text-lg"
      />

      {confirming ? (
        <ConfirmWalkUp
          {...confirming}
          pending={pending}
          onCancel={() => {
            setConfirming(null);
            focusSearch();
          }}
          onConfirm={() =>
            submit(
              { kind: "walkUp", name: confirming.name, email: confirming.email, confirmed: true },
              confirming.name,
            )
          }
        />
      ) : (
        <ResultPanel result={lastResult} />
      )}

      <div className="space-y-3">
        {query.trim().length > 0 && results.length === 0 && (
          <EmptyState inline>
            Nobody on the list matches that.
            {allowWalkUps && " Use “Add someone not on the list” below."}
          </EmptyState>
        )}

        <ul className="divide-y divide-border">
          {results.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <div className="truncate text-base font-medium text-foreground">{c.name}</div>
                <div className="flex flex-wrap items-center gap-2 text-xs text-subtle-foreground">
                  {c.netId && <span className="font-mono">{c.netId}</span>}
                  {c.email && <span className="truncate">{c.email}</span>}
                  {c.departmentCodes.length > 0 && <span>{c.departmentCodes.join(", ")}</span>}
                  {/* Surfaced at the door, not hidden in a report: this is the
                      person whose attendance will not count until they finish
                      onboarding, and the operator can tell them so in person. An
                      accepted applicant is off-roster by definition, so saying
                      both would be noise -- "Accepted, not onboarded" is the
                      whole story for them. */}
                  {c.kind === "applicant" ? (
                    <Badge tone="warning">Accepted, not onboarded</Badge>
                  ) : (
                    c.offRoster && <Badge tone="warning">Not on the roster</Badge>
                  )}
                </div>
              </div>
              {isDone(c) ? (
                <span className="shrink-0 text-sm text-success-foreground">Checked in</span>
              ) : (
                <Button disabled={pending} onClick={() => submitCandidate(c)}>
                  Check in
                </Button>
              )}
            </li>
          ))}
        </ul>
      </div>

      {allowWalkUps && !confirming && (
        <Card>
          {walkUpOpen ? (
            <WalkUpForm
              pending={pending}
              onCancel={() => {
                setWalkUpOpen(false);
                focusSearch();
              }}
              onSubmit={(name, email) => submit({ kind: "walkUp", name, email }, name)}
            />
          ) : (
            <Button variant="outline" onClick={() => setWalkUpOpen(true)}>
              Add someone not on the list
            </Button>
          )}
        </Card>
      )}

      <div className="border-t border-border pt-4">
        {/* Counted off the SERVER's list alone, never that list plus the local
            `justCheckedIn` set. A server action re-renders this page's server
            components, so checkedInNames already contains whoever was just
            tapped; adding the local set on top counts them twice for as long as
            the operator stays on the screen. The local set is for row state,
            where a union is idempotent, and for nothing else. */}
        <h2 className="text-sm text-muted-foreground">
          <span className="font-semibold text-foreground">Checked in {checkedInNames.length}</span>
          {acceptedCount !== null && <> of {acceptedCount} accepted</>}
        </h2>
        <ul className="mt-2 space-y-1 text-sm">
          {checkedInNames.map((name, i) => (
            <li key={`${name}-${i}`} className="text-foreground-soft">
              {name}
            </li>
          ))}
          {checkedInNames.length === 0 && (
            <li className="text-subtle-foreground">Nobody yet.</li>
          )}
        </ul>
      </div>
    </div>
  );
}

/** What the panel renders. Assembled on the client from the server's outcome. */
type DoorResult = {
  name: string;
  alreadyCheckedIn: boolean;
  /** Short labels for what is outstanding. Empty means fully cleared. */
  needs: string[];
  /** They owe an application, not just the contract the `needs` chip names. */
  notOnAcceptedList: boolean;
  contactEmail: string | null;
  nudgeQueued: boolean;
};

/**
 * The last check-in, held on screen until the next one replaces it.
 *
 * Persistent rather than a toast on a timer, because its audience is a
 * conversation: the operator reads the outstanding items to the person standing
 * in front of them, and a panel that fades after four seconds is one they have
 * to redo the check-in to get back.
 *
 * aria-live because the screen does not navigate, so there is no page change for
 * a screen reader to announce.
 */
function ResultPanel({ result }: { result: DoorResult | null }) {
  if (!result) {
    return (
      <div
        aria-live="polite"
        className="rounded-xl border border-dashed border-border px-5 py-6 text-sm text-subtle-foreground"
      >
        Scan or type a NetID to check someone in.
      </div>
    );
  }
  const cleared = result.needs.length === 0;
  return (
    <div
      aria-live="polite"
      className={`space-y-3 rounded-xl border px-5 py-4 ${
        cleared ? "border-border bg-surface" : "border-warning bg-surface"
      }`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="text-2xl font-semibold text-foreground">{result.name}</span>
        <span
          className={`text-sm font-semibold ${
            result.alreadyCheckedIn ? "text-warning-foreground" : "text-success-foreground"
          }`}
        >
          {result.alreadyCheckedIn ? "Already checked in" : "Checked in"}
        </span>
      </div>

      {cleared ? (
        <p className="text-sm text-success-foreground">Nothing outstanding. Fully cleared.</p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-foreground">Still needs</span>
          {/* Leads the chips: for somebody who never applied, "Onboarding
              contract" alone is a true answer to the wrong question, and this is
              the sentence the operator has to say while they are still standing
              there. */}
          {result.notOnAcceptedList && <Badge tone="critical">An application</Badge>}
          {result.needs.map((need) => (
            <Badge key={need} tone="warning">
              {need}
            </Badge>
          ))}
        </div>
      )}

      {/* Read back so a wrong address gets corrected in the one moment the person
          it belongs to is standing there. Only when something actually went out:
          a second scan of somebody already checked in sends no second email, and
          claiming otherwise would be the screen lying about a send. */}
      {result.nudgeQueued && result.contactEmail && (
        <p className="text-xs text-subtle-foreground">
          Reminder sent to <span className="font-medium">{result.contactEmail}</span>
        </p>
      )}
    </div>
  );
}

/**
 * The question the door asks before recording somebody nobody accepted.
 *
 * A typo in an address and a person who should not be at this session look
 * identical to the server, and both are worth one question here -- where the
 * human is standing in front of the operator to answer it -- rather than a row
 * somebody reconciles months later.
 */
function ConfirmWalkUp({
  name,
  email,
  message,
  pending,
  onConfirm,
  onCancel,
}: {
  name: string;
  email: string;
  message: string;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      aria-live="assertive"
      className="space-y-3 rounded-xl border border-warning bg-surface px-5 py-4"
    >
      <p className="text-base font-medium text-foreground">{message}</p>
      <p className="text-sm text-subtle-foreground">
        Checking in anyway records their attendance and emails {email} what they need to do.
      </p>
      <div className="flex items-center gap-2">
        <Button disabled={pending} onClick={onConfirm}>
          Check in anyway
        </Button>
        <Button variant="ghost" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <span className="sr-only">{name}</span>
    </div>
  );
}

/**
 * Walk-up capture: a name and an email, both required.
 *
 * The email is not optional and not a nicety. It is the ONLY thing that can
 * later connect this row to a person (see linkAttendanceByEmail) and the only
 * way to reach them about their outstanding onboarding. A row without one is a
 * tally mark.
 *
 * Reached less often than it used to be: anyone the cycle has accepted is now in
 * the search list above under their own name, whether or not they have onboarded,
 * so this form is for the genuinely unknown rather than for every attendee whose
 * contract had not landed yet.
 */
function WalkUpForm({
  pending,
  onCancel,
  onSubmit,
}: {
  pending: boolean;
  onCancel: () => void;
  onSubmit: (name: string, email: string) => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const ready = name.trim().length > 0 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Full name"
          aria-label="Attendee name"
        />
        <Input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email"
          aria-label="Attendee email"
        />
      </div>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={pending || !ready}
          onClick={() => onSubmit(name.trim(), email.trim())}
        >
          Check in
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
      <p className="text-xs text-subtle-foreground">
        The email is how this attendance gets matched to their account later, and how we tell them
        what is still outstanding.
      </p>
    </div>
  );
}
