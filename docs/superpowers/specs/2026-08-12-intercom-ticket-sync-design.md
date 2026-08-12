# Intercom to TechRequest two-way sync (2026-08-12)

## Problem

Intercom is now the front door for support, but `TechRequest` is the system of record (see
`2026-08-11-intercom-fin-mcp-design.md`). Today those two facts do not meet: a member can hold a
whole conversation in the Messenger and nothing lands in the Hub, so IT has no ticket to work, no
number to quote, and no audit trail. Conversely a director resolving a `TechRequest` in the Hub
leaves the member's Intercom thread silent.

This spec connects them without moving the record.

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

A new authenticated endpoint, `POST /api/support/tickets/from-conversation`.

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

**`AWAITING_YNHH` is the one worth the effort.** It is the status Intercom has no native equivalent
for, and it is the most useful thing a member can be told: the request is blocked on Yale New Haven
Health, not forgotten. It maps to the custom "Waiting on YNHH" state.

**Failure is non-blocking.** A Hub status change must never fail because Intercom is unreachable.
This follows the same posture as `notify()` and the DB-unreachable degradation rule: the write of
record succeeds, the outbound message is attempted and its failure logged.

## What is deliberately not built

- **No inbound message sync.** Intercom conversation messages do not become `TechRequestComment`
  rows. Two systems holding the same thread means two sources of truth for what was said, and the
  merge conflicts are unresolvable. The conversation lives in Intercom; the Hub holds the record.
- **No status sync from Intercom into the Hub.** Direction 2 is one-way. An agent closing an
  Intercom conversation does not resolve the `TechRequest`, because closing a chat and resolving an
  IT request are genuinely different acts.
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
