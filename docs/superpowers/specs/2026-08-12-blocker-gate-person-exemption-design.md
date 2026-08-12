# Per-person content blocker gate exemption

Date: 2026-08-12
Branch: `feat/content-blocker-gate` (PR #581), based on `feat/intercom-support` (PR #579)

Extends `2026-08-11-content-blocker-gate-design.md`. Read that first.

## Problem

The content blocker gate blocks the authenticated hub with a modal that cannot
be dismissed. The only lever today is `support.blockerGateEnabled`, which is
all-or-nothing: it stands the gate down for everybody.

That is the wrong shape for the case ops will actually hit. A member on a
managed clinic laptop, or behind a network filter they do not control, is
correctly detected (their Messenger really is broken) and genuinely cannot
comply. The gate is working as designed and the member still cannot work.
Turning the global switch off to unblock one person removes the gate from
everyone else too.

## Decision

Add a per-person exemption flag, settable by an admin on the person's page.

An exempt person is never gated. The exemption removes the block, not the help:
`IntercomMessenger` still mounts for them, so support works if it can.

### Non-goals

- A reason field or an expiry date. Considered and rejected as premature. The
  audit trail already answers who exempted whom and when, and an expiry that
  lapses silently would hard-block someone with no warning, which is the exact
  failure this flag exists to prevent.
- Self-service. A member cannot exempt themselves. Setting the flag requires
  `admin.manage_people`, the same permission the rest of the page requires.
- Any change to detection. The probe is unchanged.

## Schema

One column on `Person`:

```prisma
blockerGateExempt Boolean @default(false)
```

Additive, defaulted, and read by nothing that exists today, so a deploy where
the branch and the database briefly disagree cannot break: older code ignores
the column, newer code sees the default.

## Carrying the flag to the decision

`PersonSession` (`src/platform/auth/session.ts:20`) already carries
`themePreference` and `photoVersion` for exactly this kind of layout-level
decision, and `requirePersonSession()` runs on every `(app)` render anyway.
Adding `blockerGateExempt` to that payload costs no extra query.

## The decision itself

The gate now has three independent off-switches:

1. No Intercom app id (`supportAppId` null): the feature is off entirely.
2. `support.blockerGateEnabled` false: ops stood the gate down globally.
3. `blockerGateExempt` true: this person is exempt.

Three booleans ANDed inline in JSX is where a subtle mistake hides, and every
one of these is load-bearing (getting it wrong either locks out someone who
should be exempt, or fires a hard block in CI). So the rule lives in one named
predicate rather than in the layout's markup:

```ts
shouldMountBlockerGate(input: {
  supportAppId: string | null;
  gateEnabled: boolean;
  personExempt: boolean;
}): boolean
```

`src/app/(app)/layout.tsx` calls it. The rule is then unit-testable directly,
instead of only through a server component that is awkward to mount in a test.

`IntercomMessenger` keeps its own condition, `supportAppId` alone. That
asymmetry is deliberate and is the same one the global kill switch established:
standing the gate down must never remove support from the people who can still
reach it.

## Admin UI

A checkbox on `src/app/(app)/admin/people/[id]/page.tsx`, beside the existing
`spanishVerified` and `licensedRN` checkboxes, which are already read off the
same form as `formData.get(...) === "on"`.

Copy must state the consequence, not just the mechanic, because the admin
setting it is deciding on someone else's behalf. Exact strings:

- Label: `Skip the content blocker check`
- Help: `This person can use the hub without turning off their content blocker.
  Support may not reach them, so use this for people on a managed device or
  network they cannot change themselves.`

Add `blockerGateExempt` to the `fields` array in `updatePersonFields`
(`src/platform/people.ts:191`). That function already diffs changed keys inside
its transaction and writes the audit entry, so the flag becomes audited with no
additional work: who exempted whom, and when.

## Testing

- `shouldMountBlockerGate`: each switch independently, plus combinations. The
  cases that matter are "exempt person is not gated", "non-exempt person with
  everything else on IS gated", and "no app id never gates regardless of the
  other two".
- `updatePersonFields` records an audit entry when `blockerGateExempt` changes,
  and does not when it is absent from the input.
- The full suite covers the migration and the session payload change.

## The risk worth naming

This is a permanent, self-service (for admins) bypass of a control that was
deliberately built to be undismissable. The audit log makes each grant
accountable but does nothing to make the set of grants self-correcting. If
exemptions accumulate, the gate quietly stops protecting anyone, and nothing in
the code will say so. The honest signal is the count of exempt people, and it is
worth looking at that periodically rather than trusting the design to hold.
