# Intercom to TechRequest two-way sync (2026-08-12)

## Problem

Intercom is now the front door for support, but `TechRequest` is the system of record (see
`2026-08-11-intercom-fin-mcp-design.md`). Today those two facts do not meet: a member can hold a
whole conversation in the Messenger and nothing lands in the Hub, so IT has no ticket to work, no
number to quote, and no audit trail. Conversely a director resolving a `TechRequest` in the Hub
leaves the member's Intercom thread silent.

This spec connects them without moving the record.

## Where the work happens (decided 2026-08-12)

Staff work the conversation in **Intercom**, not in the Hub. `/support/[id]` stops being a
workspace and becomes the record: status, assignment, priority, internal notes, and the Epic chain.
Member-facing correspondence happens where the member already is.

That decision has a corollary worth stating plainly, because it is the part that could be
over-applied: **only support correspondence moves.** Recruitment decisions, shift reminders,
compliance reminders, onboarding contract links, and campaigns keep sending through the existing
Graph transport as `hfc.it@yale.edu`. They are not support conversations, and two facts make moving
them actively harmful:

- The Messenger only boots inside the authenticated `(app)` shell, so it **cannot reach an
  applicant at all** -- confirmed while building `my_application_status`. A recruitment decision
  delivered only through Intercom would never arrive.
- Every mainstream ad blocker blocks `widget.intercom.io`. A member running one would silently miss
  "you are not cleared for Saturday's clinic". Email has no such failure mode.

Epic and ITCM keep their Hub steps regardless. Intake needs `govId`, and no part of that may be
collected or displayed in chat.

## What stays where

Restating the decision this builds on, because every rule below follows from it:

- `TechRequest` is authoritative. Number, status, assignment, priority, comments, and attachments
  live in the Hub.
- Intercom owns the conversation: the member's messages, Fin's answers, and the human agent's
  replies.
- `EpicRequest` into `YnhhTicket` into ITCM PDF is untouched. Intercom never models it.
- **`TechRequest.govId` must never reach Intercom.** Epic and ITCM intake always happens in a Hub
  form. The sync may reference an Epic request's existence and status; it may never carry its
  contents.

## The join key

`TechRequest` gains one nullable column:

```prisma
/// The Intercom conversation this ticket was opened from, when it came in through
/// support chat rather than the Hub form. Unique: a conversation maps to at most one
/// ticket, which is what makes the create path idempotent under Intercom retries.
intercomConversationId String? @unique
```

Unique is doing real work. Intercom retries webhooks and Fin can call an action more than once in a
turn, so without it a flaky network produces duplicate tickets with consecutive numbers and no way
to tell which one IT should work.

The reverse link already exists on the Intercom side: every ticket type carries a `Hub ticket
number` attribute, created 2026-08-11 for exactly this purpose.

## Direction 1: conversation into TechRequest

**Revised 2026-08-12: an agent decides, not Fin.** Most conversations are a quick question that Fin
answers and nobody needs to track. Auto-filing every one of them would fill the queue with things
that are not work. So a `TechRequest` is created when an agent uses Intercom's native "create
ticket" on a conversation, which fires a `ticket.created` webhook that this endpoint serves.

Three consequences, all improvements:

- Human judgement decides what is a ticket, rather than an AI inferring it. Fin needs no
  ticket-creation action at all, which removes that connector configuration and the risk of the
  model filing tickets on its own.
- The webhook carries a real Intercom **ticket id**, which is what finally makes the `Hub ticket
  number` write-back possible. The earlier attempt failed because this path only ever had a
  conversation id, and that attribute lives on ticket types, a different object.
- An Intercom Ticket now exists by construction, which Direction 3 needs: conversations have no
  state to sync.

`TechRequest` therefore carries **two** Intercom links, both unique and both nullable. They are
different objects and are used for different things: `intercomConversationId` resolves identity and
receives internal notes; `intercomTicketId` carries state and the number attribute. Collapsing them
into one field is the mistake that cost an afternoon the first time.

The endpoint itself is otherwise unchanged from what is described below.

**Auth and identity reuse what the MCP server already does.** Bearer auth proves the caller is our
Intercom connector; identity comes from `resolveIdentityFromConversation(conversationId)`, never
from a requester id in the body. That matters more here than on a read tool: this path *writes*, so
a forged requester would file a ticket as somebody else.

**Request:** `conversationId`, `category` (a `TechRequestCategory`), `subject`, `description`.

**Behaviour:**

1. Resolve identity from the conversation. Refuse if it does not resolve, exactly as the MCP tools
   do, with the same undifferentiated message.
2. If a `TechRequest` already exists for that conversation, return it unchanged. Idempotent, not an
   error: Intercom retrying is normal, not a fault.
3. Otherwise create the `TechRequest` with `requesterId` set to the resolved person and
   `status: SUBMITTED`.
4. Write the new `number` back onto the Intercom conversation's `Hub ticket number` attribute.
5. Return the number so Fin can tell the member.

**The category is chosen, not inferred.** `EPIC` is accepted as a category so the ticket is routed
correctly, but the endpoint takes none of the Epic intake fields. Fin's reply for an Epic request
links the member to the Hub form; it never collects a government ID, a date of birth, or a mirror
Epic id in chat.

**Step 4 is best-effort.** If writing the attribute back fails, the ticket still exists and the
member still gets their number. A failed back-reference is a cosmetic problem; refusing to create
the ticket because of it would lose the member's request.

## Direction 2: TechRequest status into the conversation

When a linked `TechRequest` changes status, post the update into its Intercom conversation so the
member sees it where they asked, rather than only in an email or in the Hub.

**Where it hooks:** the existing status-transition path in `src/modules/support/services`, not a
new one. There is already notification behaviour there; this joins it rather than competing.

**What gets posted:** the new status in member-facing language, and the resolution text when there
is one. Never internal comments. `TechRequestComment.visibility` already separates `PUBLIC` from
`INTERNAL`, and only `PUBLIC` may cross.

**This replaces the requester-facing support email, and only that.** `notifyTicketSubmitted` is the
one support notification today; a linked ticket should tell the member through their conversation
instead of emailing them. Staff-facing notification (telling IT a ticket arrived) is a different
audience and is not member correspondence, so it keeps whatever channel it uses now. Do not widen
this into the platform's other email paths.

**`AWAITING_YNHH` is the one worth the effort.** It is the status Intercom has no native equivalent
for, and it is the most useful thing a member can be told: the request is blocked on Yale New Haven
Health, not forgotten. It maps to the custom "Waiting on YNHH" state.

**Failure is non-blocking.** A Hub status change must never fail because Intercom is unreachable.
This follows the same posture as `notify()` and the DB-unreachable degradation rule: the write of
record succeeds, the outbound message is attempted and its failure logged.

## Direction 3: Intercom ticket state into TechRequest.status

Agents work the ticket in Intercom. When they change its state there, a webhook updates
`TechRequest.status`. Intercom becomes the control surface; the Hub stays the record.

This is what makes "managed in Intercom" true rather than aspirational, and it resolves a problem
Direction 2 created on its own. Because Hub-written content posts as an internal note, a member
cannot see status in a note. But an Intercom **Ticket** shows its state to the customer natively,
in Intercom's own UI. So the member sees "In progress" or "Waiting on Yale New Haven Health"
without any Hub-authored text reaching them, and the Hub's member-facing support pages stop being
load-bearing.

A Ticket exists by construction here, because Direction 1 is now driven by an agent creating one
(see its 2026-08-12 revision). Conversations have no state to sync, so that revision is what makes
this direction possible at all, and what makes the six ticket types and their `Hub ticket number`
attribute meaningful rather than decorative.

The webhook receiver therefore handles two event kinds: `ticket.created` opens the Hub record, and
ticket state changes update its status. Same signature verification, same origin tagging, one
endpoint.

### State mapping

Intercom's ticket states are configurable, so every `TechRequestStatus` can reach a state in the
workspace; "Waiting on YNHH ITS" was created for exactly this and stops being a nicety here.

**Revised after building against the live workspace.** The original text here assumed a 1:1 mapping
derived from the Hub's own `STATUS_LABELS`. Two things turned out to be false:

- **The vocabularies differ on purpose.** `STATUS_LABELS` is Hub UI text written for managers; the
  workspace's state labels are copy ops wrote for members, and read better ("Waiting on YNHH
  Collaboration" to a member, versus the Hub's "Awaiting YNHH"). Deriving one from the other forced
  them to be identical, so labels that differed failed to map in both directions, silently.
- **The mapping is not 1:1.** Ops treats closed and resolved as one outcome and did not want a
  second terminal state in the member's view, so `RESOLVED` and `CLOSED` both map outbound to
  `Resolved`. `Resolved` maps back to `RESOLVED` (what the Hub's own resolve path sets).
  `Won't fix` exists in the workspace with no outbound counterpart and maps inbound to `CLOSED`.

So the two directions are **explicit tables, not mirrors** (`intercom-sync.ts`). The invariant worth
testing is not "every status round-trips" -- `CLOSED` cannot -- but "every label the Hub can push is
one the Hub can read back".

A state arriving with no mapping must be **rejected and logged, not guessed**. Silently coercing an
unknown state into the nearest-looking status is how a ticket ends up Resolved because somebody
added a state in the Intercom UI.

### The loop, which is the part that bites

Status will move in both directions. Intercom drives it normally, but Epic transitions originate in
the Hub: `AWAITING_YNHH` comes from the YNHH workflow, not from an agent. Naively, a Hub write
pushes to Intercom, Intercom's webhook fires back, and the Hub writes again.

Suppression is required, not optional. Tag each change with its origin and do not echo a change
back to the side it came from. A no-op guard alone (skip when the incoming status already matches)
is necessary but not sufficient, because two changes racing in opposite directions can still
ping-pong before converging.

### Security

The webhook is an unauthenticated-by-default write path into ticket status, so it must verify
Intercom's request signature before doing anything. An unsigned or mis-signed payload is dropped
and logged, never applied.

## What is deliberately not built

- **No inbound message sync.** Intercom conversation messages do not become `TechRequestComment`
  rows. Two systems holding the same thread means two sources of truth for what was said, and the
  merge conflicts are unresolvable. The conversation lives in Intercom; the Hub holds the record.
- ~~**No status sync from Intercom into the Hub.**~~ **Reversed 2026-08-12.** This was the wrong
  call for the actual goal. The original reasoning -- that closing a chat and resolving an IT
  request are different acts -- is a reason to map states carefully, not a reason to refuse the
  sync. Refusing it forced tickets to be tracked in the Hub and worked in Intercom, which is two
  places for one thing. See "Direction 3" below.
- **No Epic or ITCM writes.** Ever.

## Error handling

- Identity does not resolve: refuse, audit, and return the same message every other refusal
  returns. Do not reveal which of the causes it was.
- Database unreachable on create: 503, consistent with `/api/notifications` and the token route.
  Fin tells the member to try again rather than silently dropping the request.
- Intercom unreachable on either back-write: log, continue. Never fail the Hub-side operation.

## Testing

- Idempotency: the same `conversationId` twice creates one ticket and returns the same number. This
  is the test that matters most, because the failure it prevents is silent duplicate tickets.
- The requester is the person resolved from the conversation, never a value from the request body.
  Include a case where the body carries a different person id and assert it is ignored.
- No response and no outbound Intercom payload ever contains `govId`, `dateOfBirth`, or Epic intake
  fields.
- `INTERNAL` comments never cross; `PUBLIC` ones may.
- An Intercom outage during either back-write leaves Hub state correct and the operation successful.

## Open questions

1. Whether Intercom's conversation-attribute write requires the conversation to be in a particular
   state. Needs one live check before implementing step 4.
2. Whether a member replying in a closed Intercom conversation should reopen the `TechRequest`, or
   whether the two lifecycles stay fully independent. Leaning independent, per the not-built list.
