# Self-withdrawal offboarding alert

Date: 2026-07-30

## Problem

A volunteer on `/my-info` can click "I am not volunteering this term". That calls
`withdrawFromTerm` (`src/modules/my-info/services/my-info.ts`), which flips their
ACTIVE VOLUNTEER memberships in the active term to `REMOVED`, writes an audit row,
and stops there.

Three things go wrong from that point:

1. **Nobody is told.** The only record is an audit row nobody reads.
2. **The person is half-offboarded.** `Person.status` stays `ACTIVE`, so Epic access
   is untouched, compliance reminders keep firing, and every status-keyed roster
   still counts them. A real offboard (status flip plus Epic revocation) only
   happens through `/volunteers/offboarding` -> flag -> `executeOffboard`.
3. **They vanish from the one screen that could catch it.** The department cards on
   `/volunteers/offboarding` list ACTIVE memberships only, so the moment the
   withdrawal commits the person disappears from their director's view, and they
   were never in the flagged queue to begin with.

## Goal

When someone declares they are not volunteering this term, the people who process
offboarding learn about it and have a row to act on.

## Non-goals

- Changing what withdrawal does to memberships. It still removes them immediately.
- Notifying department directors. Out of scope for this change; the offboarding
  managers are the ones who can actually complete an offboard.
- Confirming back to the member. The existing `?withdrawn=N` banner is enough.
- Any schema change. `OffboardFlag` already has every field this needs.

## Design

### 1. Optional reason on the member's form

`MembershipsCard` (`src/modules/my-info/components/memberships-card.tsx`) gains an
optional reason input in the existing withdraw form, beside the `ConfirmButton`:

```tsx
<form action={withdrawAction} className="mt-4 flex items-center gap-2">
  <Input name="reason" placeholder="Reason (optional)" aria-label="Reason (optional)" />
  <ConfirmButton label="I am not volunteering this term" confirmLabel="Confirm withdrawal?" />
</form>
```

This is the same shape as the flag form already on `/volunteers/offboarding`, so it
inherits a pattern the codebase has rather than inventing one. The two-click confirm
behaviour, the styling, and the `/my-info?withdrawn=N` redirect are unchanged.

`withdrawAction` in `src/app/(app)/my-info/page.tsx` currently takes no arguments; it
gains the `formData` parameter, reads `reason`, and passes it straight down.

Normalization (trim, blank to `null`, cap at 300 characters) happens in the service,
not the action, so a direct service call cannot bypass it. This matches how
`updateMyInfo` whitelists its fields at the service level rather than trusting the
form. The input also carries `maxLength={300}` for the UX.

### 2. `withdrawFromTerm` gains a reason and two side effects

Signature becomes `withdrawFromTerm(personId: string, reason?: string | null)`.

Order of operations:

1. **Read the departments first.** Before the update, select the VOLUNTEER
   memberships about to be removed and keep their department codes. They are needed
   for the flag note and the notification body, and they are unreachable once the
   rows are `REMOVED`.
2. **Remove memberships.** Unchanged, including the Serializable last-admin guard.
3. **Bail on zero.** `count === 0` returns 0 with no flag and no notification. This
   doubles as the dedup: a second click, or a click by someone with no volunteer
   membership, is silent.
4. **Audit.** The existing `my-info.withdraw` row, with `reason` added to `after`.
5. **Flag and notify,** through one call into the new platform helper below, wrapped
   in `try`/`catch` with `log.error`. This copies how `saveCertificate` treats its
   compliance-manager alerts: the withdrawal is already committed and audited, so a
   Graph or Teams hiccup must never surface to the member as a failed action.

### 3. `src/platform/offboarding/self-withdrawal.ts`

New platform module exporting one function:

```ts
export async function recordSelfWithdrawal(
  db: Db,
  member: { id: string; name: string },
  detail: { departmentCodes: string[]; reason: string | null },
): Promise<number>   // number of people notified
```

**Why platform and not the volunteers module.** eslint `import/no-restricted-paths`
forbids `src/modules/my-info` from importing `src/modules/volunteers`, so the
volunteers module's `flagForOffboarding` is unreachable from the withdrawal path.
This mirrors `src/platform/compliance/review-notifications.ts`, which my-info already
imports for exactly this kind of cross-cutting alert. `flagForOffboarding` is left
untouched; its `actorCanManageTarget` scope check is meaningless here anyway, because
the actor is the subject.

**What it does:**

1. Resolve the active term. No active term means no flag and no notification; return 0.
2. **Director guard.** Count the person's remaining ACTIVE memberships in the active
   term. If any remain (the normal case being a director who also took clinic
   shifts), skip the flag entirely and set an `stillActive` flag on the message.
   Rationale: `executeOffboard` strips every membership and sets
   `Person.status = OFFBOARDED`, so flagging a sitting director puts a one-click path
   to revoking their directorship in front of ops. The queue means "should be fully
   offboarded", and they should not be.
3. **Create the flag** (when the guard passes) with `flaggedById = personId`, so the
   flagged table reads "Flagged by: <their own name>". Upsert-safe on
   `@@unique([personId, termId])`: an existing flag, including a director-raised one
   with its own note, is returned untouched rather than overwritten.

   Note text: `Not volunteering this term (MED, PCAR)`, plus ` - "<reason>"` when a
   reason was given. The department codes go in the note because the flagged table's
   Departments column derives from ACTIVE memberships, which are now `REMOVED`, so it
   would otherwise render `-` for exactly the rows that need the context most.
4. **Notify.** Recipients are
   `peopleWithAnyPermission(["volunteers.manage_offboarding", "admin.access"])` minus
   the member themselves. `peopleWithAnyPermission` treats a `*` grant as matching.
   Empty recipient list logs a warning and returns 0, mirroring
   `notifyDatelessCertReview`. Each recipient goes through `notify()`, so delivery
   follows the admin's per-type channel setting (email, Teams DM, or both) and always
   lands in the in-app inbox. Link target is `/volunteers/offboarding`.

### 4. Notification and template plumbing

| File | Change |
| --- | --- |
| `src/platform/notifications/registry.ts` | add `volunteers.self_withdrawal`, label "Volunteers: member not returning this term (offboarding managers)", default channel `email` |
| `src/platform/notifications/registry.test.ts` | add the key to the exhaustive list assertion |
| `src/platform/email/templates/volunteers.ts` | new file: `TemplateDescriptor` plus a typed context builder |
| `src/platform/email/templates/types.ts` | add `volunteers` to `TemplateGroup` |
| `src/platform/email/templates/registry.ts` | spread `volunteersDescriptors` into `ALL` |
| `src/platform/email/sender-rules.ts` | add `{ group: "volunteers", label: "Volunteers" }` to `SENDER_CATEGORIES` |

The settings registry derives a channel-picker setting per notification type from
`NOTIFICATION_TYPES`, so the admin toggle at `/admin/notifications` appears without
further work.

Template context variables: `memberName`, `departments` (a precomputed
comma-joined string, since the render engine has no `{{#each}}`), `reason`,
`hasReason`, `stillActive`, `reviewLink`. Body copy branches on `stillActive`:
either "they are flagged for offboarding, review the queue" or "they remain
active in another role, no offboarding needed".

Deliberately no `recipientName`: the email is rendered once with `renderEmail`
outside the per-recipient `notify()` loop and the same rendered subject/html is
reused for every recipient. Rendering per recipient to greet each one by name
would cost N template renders plus N extra DB round trips (the template
override lookup and the brand color setting) for a notification whose audience
is a handful of offboarding managers, not worth it for a greeting line.

## Testing

- `src/platform/offboarding/self-withdrawal.test.ts` (new): recipients resolve from
  the permission, the member is excluded, no active term is a no-op, the director
  guard suppresses the flag but not the notification, an existing flag is not
  overwritten, note text includes department codes and the reason.
- `src/modules/my-info/services/my-info.test.ts`: withdrawing creates the flag and
  queues the notification, a zero-count withdrawal does neither, a thrown notification
  error does not fail the withdrawal or roll back the membership removal.
- Existing `withdrawFromTerm` tests keep passing unchanged; the new parameter is
  optional.

## Risks

- **Double flagging.** A director flags someone, then that person self-withdraws. The
  upsert-safe create keeps the director's flag and note, and the notification still
  goes out. Acceptable: the self-declaration is new information worth sending.
- **Notification volume at term boundaries.** If many people withdraw in one week,
  offboarding managers get one message each. Batching is not worth building until
  ops says it is a problem; the channel setting already lets them route these to
  Teams or inbox-only instead of email.
