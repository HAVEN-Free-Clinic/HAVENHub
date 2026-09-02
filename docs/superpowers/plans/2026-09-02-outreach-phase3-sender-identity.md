# Outreach Phase 3: sender identity

Implements the "Sender identity (Phase 3)" section of
`docs/superpowers/specs/2026-08-31-outreach-campaigns-design.md`.

Branches off `main`. Phase 3 is independent of Phases 1 and 2, which the spec
states explicitly, so this does not stack on the open Phase 2 PRs (#707, #710).

## The state of the two domains, verified 2026-09-02

Not assumed. Checked in DNS today, and consistent with a live Maileroo send
probed on 2026-08-21.

| | `havenfreeclinic.org` | `yale.edu` |
| --- | --- | --- |
| SPF | `include:_spf.maileroo.com` | Valimail only, **no Maileroo include** |
| Maileroo DKIM selector | not at `maileroo._domainkey` | not at `maileroo._domainkey` |
| DMARC | `p=reject` | `p=quarantine` |
| Maileroo account | verified, sends today | **registered but DISABLED** |
| Working transport today | Maileroo, any address | Graph, as `hfc.it@yale.edu` |

A live Maileroo send as `hfc.it@yale.edu` returns HTTP 400: *"The domain
'yale.edu' is currently disabled. Please check your dashboard for more
details."* Re-enabling it is a Yale ITS DNS change plus a Maileroo dashboard
action. **It is not a code change and this plan does not pretend otherwise.**

## The design consequence

The spec frames Phase 3 as a verified-domain allowlist, and says it is "correct
regardless of which domains are verified: a newly verified domain simply joins
the allowlist". That is right, but an allowlist alone is not enough to make BOTH
domains work today, because the two domains are signable by *different
transports*.

So the allowlist maps each domain to the transport that can actually sign for
it:

| From domain | Transport | Which addresses |
| --- | --- | --- |
| `havenfreeclinic.org` | Maileroo | any address on the domain |
| `yale.edu` | Graph | the delegated mailbox, plus any Exchange Send-As grants |
| anything else | Maileroo, pinned | falls back to today's pin + Reply-To |

This is what makes "use both yale.edu and havenfreeclinic.org" true now rather
than after a DNS change. When Maileroo's yale.edu entry is re-enabled, moving
that row from Graph to Maileroo is a one-line config change and nothing else
moves.

**The consequence to surface, not hide:** Graph inherits Exchange Online's
~30 messages/minute submission cap, which is the reason `MailerooTransport`
exists at all. A roster-wide campaign sent from a `yale.edu` identity will pace
out over hours. A campaign sent from `havenfreeclinic.org` will not. The UI must
say so at the point the identity is chosen, because it is invisible otherwise
and only discovered after a slow send.

## Task 1: the allowlist and transport routing

**Files:** `src/platform/email/transport.ts`, `src/platform/email/config` or
`src/platform/config.ts`, plus the queue drainer's transport selection.

- A `SENDING_DOMAINS` map: domain to transport capability. Both domains present,
  `havenfreeclinic.org` to Maileroo and `yale.edu` to Graph. Configurable, so a
  dashboard change does not need a deploy to be *reflected*, but defaulted to
  the table above.
- `MailerooTransport`: replace the hard pin with the allowlist. A From whose
  domain Maileroo can sign sends **as itself**; anything else keeps today's
  pin-plus-Reply-To. Delete the PINNED SENDER note's claim that per-message
  overrides are always ignored, and replace it with what the code now does.
- Transport selection by From domain at dispatch.
- Maileroo's `"The domain '<d>' is currently disabled"` 400 must be classified
  **permanent**, not transient. It is a configuration state, and retrying it
  burns the queue's back-off against something that will never succeed within
  the retry window. The error text is the signal; the memory note
  `maileroo-yale-domain-disabled` records that the text also distinguishes
  "disabled" from "not associated with this sending key".

**Preserve, all load-bearing and all currently documented in that file:** the
never-retry contract (the outbox queue owns back-off and the
transient/permanent split), the Gmail `[Message clipped]` inlining, and
`fromName` staying cosmetic and never part of DKIM/SPF alignment.

## Task 2: who may send as what

**Files:** a new per-person sending identity model, `AudienceScope.fromEmail`
wiring (the columns exist and are unused), the enqueue-time resolution, and the
admin UI.

The security question, which is the whole task: a scoped sender must not be able
to send as an arbitrary address. Three sources, in resolution order:

1. The campaign's scope identity (`AudienceScope.fromEmail`), set by an admin.
2. An address explicitly **issued** to the sender (the new model). This is the
   "delegatable emails we can issue on a per person basis" half.
3. The sender's own `contactEmail`, always permitted, because it is theirs.

Then the global default. Every one of these is validated against the allowlist
at write time, so an admin cannot configure an identity that is guaranteed to
fail at send.

The UI must show the Graph throughput consequence when a `yale.edu` identity is
selected, and must not offer an address on a domain the allowlist does not
carry.

## Testing notes

- The domain-disabled 400 needs a test that pins it as permanent, since getting
  it wrong is invisible until a real send sits in the queue retrying.
- Every allowlist decision needs a test at BOTH polarities: on-list sends as
  itself, off-list falls back to pin plus Reply-To with the intended address
  preserved as Reply-To.
- `.env` points every database URL at production Neon. Use a private template
  clone on port 5434. Do not run the full suite as a gate.
- `main` has no branch protection, so every CI job is advisory. Anything only CI
  would catch has to be caught locally.
