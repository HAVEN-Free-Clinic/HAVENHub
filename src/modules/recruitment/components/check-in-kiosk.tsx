"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { Button } from "@/platform/ui/button";
import { Input } from "@/platform/ui/input";
import { Badge } from "@/platform/ui/badge";
import { Alert } from "@/platform/ui/alert";
import { Card } from "@/platform/ui/card";
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
 * size (name and email only). The server is still the authority on every
 * check-in it accepts.
 *
 * The screen never navigates: a redirect per person would throw away the search
 * box and the operator's place in the queue. What it shows instead is the
 * server's own list of who is checked in, plus a one-line result for the last
 * tap.
 *
 * The result line is deliberately NOT a running local log. A server action
 * re-renders the page's server components, so `checkedInNames` already refreshes
 * to include whoever was just tapped; keeping a parallel local list of the same
 * people rendered each of them twice (caught by e2e/event-attendance.spec.ts).
 * The server list is also the one that survives the reload a staffer working a
 * door will eventually do.
 */
export function CheckInKiosk({
  candidates,
  checkedInNames,
  action,
  allowWalkUps,
}: {
  candidates: CheckInCandidate[];
  /** Names already checked in when the page loaded, newest last. */
  checkedInNames: string[];
  action: (target: CheckInTarget) => Promise<CheckInResult>;
  /** False for a department-scoped director, who may not add unknown people. */
  allowWalkUps: boolean;
}) {
  const [query, setQuery] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<{
    name: string;
    detail: string | null;
    tone: "success" | "warning";
  } | null>(null);
  // Locally checked-in ids, merged with the server's list so a row a staffer
  // just tapped immediately reads as done without a refetch.
  const [justCheckedIn, setJustCheckedIn] = useState<Set<string>>(new Set());
  const [walkUpOpen, setWalkUpOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return [];
    const matches = candidates.filter(
      (c) => c.name.toLowerCase().includes(q) || (c.email ?? "").toLowerCase().includes(q),
    );
    // Capped so a two-letter query cannot render a thousand rows and make the
    // screen unusable exactly when someone is typing quickly.
    return matches.slice(0, 25);
  }, [candidates, query]);

  function submit(target: CheckInTarget, fallbackName: string) {
    setError(null);
    startTransition(async () => {
      const result = await action(target);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      if (target.kind === "person") {
        setJustCheckedIn((prev) => new Set(prev).add(target.personId));
      }
      const detail = result.alreadyCheckedIn
        ? "was already checked in"
        : result.blockers.length > 0
          ? `checked in, onboarding outstanding${result.nudgeQueued ? " (reminder emailed)" : ""}`
          : "checked in";
      setLastResult({
        name: result.name || fallbackName,
        detail,
        tone: result.blockers.length > 0 || result.alreadyCheckedIn ? "warning" : "success",
      });
      setQuery("");
      setWalkUpOpen(false);
      // Back to the search box so the next person can be typed without reaching
      // for the mouse.
      searchRef.current?.focus();
    });
  }

  return (
    <div className="space-y-6">
      {error && (
        <Alert tone="error" role="alert">
          {error}
        </Alert>
      )}

      {/* aria-live so the outcome is announced: the screen does not navigate, so
          there is no page change for a screen reader to pick up. */}
      <p aria-live="polite" className="min-h-5 text-sm">
        {lastResult && (
          <>
            <span className="font-medium text-foreground">{lastResult.name}</span>{" "}
            <Badge tone={lastResult.tone}>{lastResult.detail}</Badge>
          </>
        )}
      </p>

      <div className="space-y-3">
        <Input
          ref={searchRef}
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name or email"
          aria-label="Search for someone to check in"
        />

        {query.trim().length > 0 && results.length === 0 && (
          <p className="text-sm text-subtle-foreground">
            Nobody in the hub matches that.
            {allowWalkUps && " Use “Add someone not in the hub” below."}
          </p>
        )}

        <ul className="divide-y divide-border">
          {results.map((c) => {
            const done = c.checkedIn || justCheckedIn.has(c.personId);
            return (
              <li key={c.personId} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <div className="truncate font-medium text-foreground">{c.name}</div>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-subtle-foreground">
                    {c.email && <span className="truncate">{c.email}</span>}
                    {c.departmentCodes.length > 0 && <span>{c.departmentCodes.join(", ")}</span>}
                    {/* Surfaced at the door, not hidden in a report: this is the
                        person whose attendance will not count until they finish
                        onboarding, and the operator can tell them so in person. */}
                    {c.offRoster && <Badge tone="warning">Not on the roster</Badge>}
                  </div>
                </div>
                {done ? (
                  <span className="shrink-0 text-sm text-success-foreground">Checked in</span>
                ) : (
                  <Button
                    size="sm"
                    disabled={pending}
                    onClick={() => submit({ kind: "person", personId: c.personId }, c.name)}
                  >
                    Check in
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      {allowWalkUps && (
        <Card>
          {walkUpOpen ? (
            <WalkUpForm
              pending={pending}
              onCancel={() => setWalkUpOpen(false)}
              onSubmit={(name, email) => submit({ kind: "walkUp", name, email }, name)}
            />
          ) : (
            <Button variant="outline" onClick={() => setWalkUpOpen(true)}>
              Add someone not in the hub
            </Button>
          )}
        </Card>
      )}

      <div>
        <h2 className="text-sm font-semibold text-muted-foreground">
          Checked in ({checkedInNames.length})
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

/**
 * Walk-up capture: a name and an email, both required.
 *
 * The email is not optional and not a nicety. It is the ONLY thing that can
 * later connect this row to a person (see linkAttendanceByEmail) and the only
 * way to reach them about their outstanding onboarding. A row without one is a
 * tally mark.
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
