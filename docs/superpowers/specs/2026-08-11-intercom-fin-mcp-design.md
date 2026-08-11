# Intercom Fin MCP server: letting Fin answer from Hub data (2026-08-11)

## Problem

HAVEN Hub is adopting Intercom for in-hub support. Fin, Intercom's AI agent, can only answer from
help-center content, so every question whose answer lives in the database ("am I cleared for
clinic?", "when is my next shift?", "who still owes HIPAA training?") escalates to a human. Those
are the most common support questions and the most mechanical to answer.

The goal is to give Fin a way to read Hub data, scoped to whoever is asking, without creating a
second authorization system that can drift from the real one.

## The approach this replaces

The first instinct was to enable the Neon Data API on the project's database branch and point Fin at
it. That was rejected, for reasons worth recording so nobody re-proposes it.

The branch in question (`br-holy-hat-aqm2bssu`) is `main`: primary, default, protected, the
production database. A grep of the full `prisma/migrations` history for `ENABLE ROW LEVEL SECURITY`
and `CREATE POLICY` returns zero results across every migration. All 71 models are protected
purely by application-level RBAC in the Next.js layer.

The Neon Data API is PostgREST in front of a branch. It exposes the `public` schema over public
HTTPS to an `anon` and an `authenticated` role, and the only thing between a caller and a row is an
RLS policy. With no policies, enabling it with public schema access grants would expose every row of
all 71 tables, including `MemberLoginToken` (magic-link credentials, so an authentication bypass),
`IncidentReport`, `DisciplinaryAction`, and `Person.dateOfBirth`.

That is the general objection. The specific one is more decisive: **the Data API cannot express this
authorization model at all.** Its security rests on per-user JWTs keying RLS policies. Fin holds one
static credential for the life of the connector, so there is no per-user `sub` for RLS to key on.
Whatever that single credential can read, any member chatting with Fin can potentially extract.
PostgREST is also a generic query surface (arbitrary filters over arbitrary columns), so handing it
to an LLM makes the blast radius the entire exposed schema rather than the intended question.

The Data API stays off on every branch holding real data.

## What Intercom actually supports

Verified against Intercom's documentation on 2026-08-11.

Fin can connect to a **custom MCP server**: you supply a server URL and auth details, and enablement
goes through Intercom's support team rather than being self-serve. Authentication to the server is
OAuth 2.0, or a bearer token stored in Intercom where the server supports it.

The critical mechanism is how tool inputs are populated. For each input, Fin offers four options:
let Fin decide (the LLM searches the conversation for a value), a custom fixed value, **an attribute
from the user, company, or conversation**, or ignore.

Binding an input to a user attribute means Intercom injects the value and the LLM never selects it.
This is the difference between an identity the model asserts and one the platform supplies.

Intercom's own guidance is explicit that customer data attributes are not verified in general, and
that a server must "verify that the requested user ID is actually allowed for the authenticated
user rather than trusting a tool argument at face value." It also warns that "any data that is
returned to Fin from a tool response may be shared with the customer."

### The gap in this evidence

Intercom's published documentation does not state, for custom MCP servers specifically, that a
stable contact identifier is passed in request metadata. A community thread asking exactly this
suggests it is not: identifiers arrive only through explicitly configured tool inputs.

This design therefore rests on per-tool configuration being correct, and that configuration lives in
Intercom's UI, not in this repository. One input left on "let Fin decide" silently downgrades
identity from a platform-supplied attribute to an LLM assertion, and nothing in the codebase would
catch it. **This must be confirmed empirically in a sandbox workspace before any tool that reads
another person's data is enabled.** Mitigation is in the identity model below.

## Identity model

This is the core of the design. Everything else follows from it.

The chain runs:

1. `/api/support/messenger-token` mints an HS256 JWT with `user_id` set to the signed-in `Person.id`, from
   the server session and the live Person row. Shipped 2026-08-11.
2. The Messenger boots with that JWT, so Intercom's contact record carries a `user_id` the browser
   cannot forge. This is what identity verification buys.
3. The MCP tool input for identity binds to that contact attribute, so Intercom supplies it.
4. The MCP server receives a `Person.id` with cryptographic provenance.

Step 3 is configuration rather than code, which is the weak link. So the server treats the incoming
identifier as a **claim to verify, never as proof**:

- Every tool call resolves the claimed `Person.id` through `getActivePerson()`. An offboarded or
  deleted person fails closed, exactly as the token route does.
- Before any tool that reads data about someone other than the caller, the server confirms the
  claim against Intercom's REST API: fetch the contact, confirm it is identity-verified and its
  `user_id` matches. A claim that fails this check is rejected and audited.
- No tool accepts a person identifier as a free LLM-chosen argument. Identity arrives only through
  the bound attribute.

## Architecture

The MCP server is a route handler inside the existing Next.js app, not a separate service.

The reason is drift. The product decision (recorded below) is that Fin mirrors the caller's real
permissions. A separate service would either duplicate the RBAC rules or call back into the Hub
through a new internal API, and duplicated authorization diverges from the original over time. That
is the same failure mode that made the Data API unacceptable. In-process, the tools import the real
permission helpers, the real Prisma client, and the real audit log, so there is exactly one
authorization model and it cannot fall out of sync with itself.

```
src/platform/intercom/
  config.ts        # env + feature gate (shipped)
  jwt.ts           # Messenger JWT minting (shipped)
  messenger.tsx    # client boot + refresh + shutdown (shipped)
  identity.ts      # resolve + verify a claimed Person.id
  audit.ts         # tool-call audit recording
src/app/api/mcp/
  route.ts         # MCP transport endpoint
  tools/
    index.ts       # registry + the free-form-identity guard
    scheduling.ts
    compliance.ts
    roster.ts
    recruitment.ts
```

The tools live in the app layer, not under `src/platform/intercom/`, because
`import/no-restricted-paths` forbids platform code from importing module code, and forbids modules
from importing each other. A tool surface spanning schedule, compliance, roster, and recruitment can
therefore only be composed where both are legal imports, which is `src/app` (the same freedom
`(app)/layout.tsx` already uses). `identity.ts` and `audit.ts` stay in platform because they import
nothing from `src/modules`.

Tools are narrow verbs, never a generic query surface. There is no "run this query" tool and no tool
that accepts a table or column name. This holds even though permissions are mirrored: an injected
prompt that wins against a director account should reach one computed answer, not an arbitrary read.

## Authorization

Fin mirrors the caller's real permissions. If the resolved person can see something in the Hub, a
tool may return it; if not, the tool fails closed.

This was a deliberate product choice over a blanket deny-list for confidential data. The reasoning:
one authorization model is safer than two that disagree, and directors legitimately hold
`directorVisibility` over incident and disciplinary records. The trade-off accepted is that a
compromised or manipulated director session reaches more through Fin than a member session does, and
that confidential content can enter Intercom's pipeline.

The compensating controls are the narrow tool surface, mandatory contact verification before any
cross-person read, full audit, and minimal responses.

Every tool runs its existing permission check with the resolved person as the actor. Department
scoping uses `permissionDepartmentIds()`; permissions are department-blind without it.

## Data exposure rules

Because tool responses can be rendered into the chat and shared with the customer, tools return
computed answers rather than rows.

- Return the answer to the question asked, not the record it came from.
- Never return `MemberLoginToken`, session material, or anything from `photoKey` or storage keys.
- Never return `Person.dateOfBirth`. No support question needs it, and it is the highest-value
  identity field in the schema.
- Incident and disciplinary tools return status and counts by default. Narrative content requires
  the caller to hold the permission and is logged at a higher audit severity.
- Errors say the caller lacks access. They never confirm or deny that a record exists.

## Tool surface

All four domains are in scope, shipped in this order so each widens the surface only after the
previous one is observed in production. Ordering is by sensitivity, cheapest and least sensitive
first.

**Phase 1, scheduling.** Next shift for the caller, shifts on a date, uncovered shifts for a
department. Lowest sensitivity, highest everyday volume, naturally short answers.

**Phase 2, compliance and training.** Clearance status, outstanding modules, certificate expiry.
The highest support-deflection value, since "am I allowed to work?" is the most common question.
Returns status, never certificate contents.

**Phase 3, roster and people.** Department membership, member status, Epic account state. First
phase where cross-person reads are routine, so contact verification is load-bearing here.

**Phase 4, recruitment.** Cycle status, applicant counts, application stage. Overlaps the
confidential tier once decisions and scores are involved, so it ships last.

## Audit and observability

Every tool call writes to the existing platform audit log: resolved person, tool name, arguments,
whether the identity claim verified, and the permission decision. Cross-person reads and any
confidential-tier access are recorded at higher severity.

The audit trail is the primary detection mechanism for the configuration footgun above. If identity
binding is ever misconfigured, the signature is a burst of failed verification claims, or one person
appearing as the actor for implausibly many distinct queries.

Failures log through `@/platform/logging` and surface in PostHog like the rest of the platform.

## Error handling

- Unverified or unresolvable identity: refuse, audit, return a message telling the member to contact
  a human. Never fall back to an unscoped answer.
- Permission denied: refuse without revealing whether the record exists.
- Database unreachable: 503, consistent with `/api/notifications` and the token route. Fin degrades
  to escalation rather than answering from stale or partial data.
- Unknown tool or malformed arguments: reject. Do not guess at intent.

## Testing

- Unit tests per tool for the permission decision, including the denied path.
- Identity resolution tests: valid claim, offboarded person, mismatched contact, missing claim.
  The mismatched-contact case is the one that catches a real bypass, so it must fail closed.
- A test asserting no tool schema accepts a person identifier as a free-form LLM argument. This is
  the code-level guard against the configuration footgun, and it is the single most valuable test
  here.
- Response-shape tests asserting the forbidden fields never appear in any tool output.

## Open questions

1. **The identity binding must be confirmed in a sandbox workspace** before phase 3. Phases 1 and 2
   are self-scoped, so a failure there is contained; phase 3 onward is not.
2. Whether Intercom's custom MCP enablement introduces constraints not in the public docs, since it
   goes through their support team.
3. Whether Fin's data connectors (self-serve, with built-in security checks on a Security tab) are a
   better vehicle for phase 1 than a custom MCP server. The identity mechanism is identical, so this
   is a delivery question, not a security one.

## Relationship to the existing /support module

The Hub already has support ticketing, and it is two systems wearing one coat.

`TechRequest` is generic helpdesk: number, subject, description, priority, status, assignment, a
PUBLIC/INTERNAL comment thread, attachments. `EpicRequest` into `YnhhTicket` into ITCM PDF
generation, with term-batch rollup and live NEW/MODIFY/RENEW derivation, is a domain state machine
producing artifacts for YNHH on their terms. Intercom does the first well and cannot do the second
at all.

The seam between them already exists: `EpicRequest.techRequestId` is nullable with `onDelete:
SetNull`, and the schema comment records that detached requests are kept for YNHH and audit history.
Epic requests are designed to outlive the ticket they arrived on, so the ticketing layer can move
without disturbing the Epic layer.

**Decision: `TechRequest` remains the system of record. Intercom is the conversational UI over it.**
Fin is the front door and deflects what it can answer, including read-only status lookups through
the MCP tools. When a conversation needs real work it creates a `TechRequest` and returns the
number. Hub-side status changes push back into the Intercom conversation so the member sees updates
where they asked.

The hard constraint driving this: `TechRequest.govId` holds a government ID captured at submit for
Epic promotion, alongside `netId` and the other Epic intake fields. **Government ID must never enter
Intercom.** Epic and ITCM intake therefore always happens in a Hub form. Fin may route a member to
that form and may report on a request's status, but must never collect its contents in chat. No MCP
tool returns `govId` under any permission.

The two-way ticket sync is a separate piece of work and gets its own spec. This section records the
decision and the constraint so the MCP tool surface is designed against them.

## Out of scope

- Any write path. Every tool is read-only. Fin does not book shifts, update records, or send email.
- The public apply portal. The Messenger is mounted on authenticated `(app)` routes only.
- Patient data. The Hub holds none, and no tool may become a route to any.
