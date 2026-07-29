# HIPAA Verification Wait Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tell a volunteer the truth about where their HIPAA certificate is while it awaits manager verification, and tell them when it clears.

**Architecture:** Three coordinated changes. The onboarding engine gains an `IN_PROGRESS` result for the two pending compliance statuses (a state it already models and renders). The checklist and the `/my-info` panel gain copy for that state. `verifyCertificate` gains a notification to the certificate owner, following the existing helper-plus-email-descriptor pattern used by its sibling manager alerts.

**Tech Stack:** Next.js App Router, Prisma, Vitest, the existing `notify()` dispatcher and `renderEmail` template registry.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-29-hipaa-verification-wait-design.md`. Read it before Task 1.
- Source findings: PR #474, `docs/full-app-ux-audit-2026-07-29.md`, items R1, R18, R19.
- **No em-dashes anywhere, in prose or code.** CI enforces this via the `local/no-em-dash` eslint rule.
- **The gate's behavior must not change.** `IN_PROGRESS` fails `isSatisfied`, so exactly the same people are blocked before and after. Task 1 carries the test that proves it.
- HAVEN voice for all copy: sentence case, no em-dashes, plain language. `STEP_DEFAULTS` names this convention at `src/modules/onboarding/services/step-config.ts:28-30`.
- Lint with `npx eslint src` while iterating. Plain `npm run lint` walks a gitignored design-system directory and produces noise. Run `npm run typecheck` before each commit.
- The full test suite has 7 to 9 pre-existing failures on `main`, all storage and ordering flakes (disk writes, blob cleanup, `listAcceptances` order). They are not yours. Compare against `main` before assuming you broke something.

## File structure

- Modify: `src/modules/onboarding/engine/status.ts` (the derivation)
- Modify: `src/modules/onboarding/engine/status.test.ts` (its tests)
- Modify: `src/modules/onboarding/services/step-config.ts` (pending copy lives with the other copy)
- Modify: `src/modules/onboarding/services/onboarding.ts` (apply pending copy in `buildTask`)
- Modify: `src/modules/my-info/components/hipaa-panel.tsx` (explain the wait)
- Modify: `src/platform/email/templates/compliance.ts` (context builder + descriptor)
- Modify: `src/platform/notifications/registry.ts` (one new type)
- Modify: `src/platform/compliance/review-notifications.ts` (the owner-facing helper)
- Modify: `src/modules/volunteers/services/compliance.ts` (call it on the transition)

---

### Task 1: Give the HIPAA task an IN_PROGRESS state

**Files:**
- Modify: `src/modules/onboarding/engine/status.ts:19-22`
- Test: `src/modules/onboarding/engine/status.test.ts:24-34`

**Interfaces:**
- Produces: `deriveHipaaTaskState(status: ComplianceStatus): OnboardingTaskState`, unchanged signature, now returning `"IN_PROGRESS"` for `PENDING_VERIFICATION` and `UNKNOWN_DATE`. Tasks 2 and 5 depend on this state existing for the `hipaa` key.

- [ ] **Step 1: Write the failing tests**

Replace the existing `deriveHipaaTaskState` describe block (currently at `status.test.ts:24-34`) with this. It covers all six `ComplianceStatus` values, and adds the gate-unchanged regression test the spec's non-goal requires.

```ts
describe("deriveHipaaTaskState", () => {
  it("is COMPLETE when compliant or expiring soon", () => {
    expect(deriveHipaaTaskState("COMPLIANT")).toBe("COMPLETE");
    expect(deriveHipaaTaskState("EXPIRING_SOON")).toBe("COMPLETE");
  });
  it("is IN_PROGRESS when a certificate is on file but a manager has not confirmed it", () => {
    expect(deriveHipaaTaskState("PENDING_VERIFICATION")).toBe("IN_PROGRESS");
    expect(deriveHipaaTaskState("UNKNOWN_DATE")).toBe("IN_PROGRESS");
  });
  it("is INCOMPLETE when there is nothing usable on file", () => {
    expect(deriveHipaaTaskState("EXPIRED")).toBe("INCOMPLETE");
    expect(deriveHipaaTaskState("NO_CERTIFICATE")).toBe("INCOMPLETE");
  });
  // The point of IN_PROGRESS is to change what the member is TOLD, not who is
  // blocked. If this ever passes, the fix has silently cleared people who are
  // still waiting on a manager.
  it("does not satisfy the gate, so the same people stay blocked", () => {
    expect(isSatisfied(deriveHipaaTaskState("PENDING_VERIFICATION"))).toBe(false);
    expect(isSatisfied(deriveHipaaTaskState("UNKNOWN_DATE"))).toBe(false);
  });
});
```

`isSatisfied` is already imported at `status.test.ts:8`.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/modules/onboarding/engine/status.test.ts`
Expected: the IN_PROGRESS test fails with `expected 'INCOMPLETE' to be 'IN_PROGRESS'`. The gate test should already PASS, because `INCOMPLETE` also fails `isSatisfied`; that is fine and is the point. It must still pass at the end.

- [ ] **Step 3: Make the change**

In `src/modules/onboarding/engine/status.ts`, replace the function and its docstring:

```ts
/** A HIPAA cert that is valid today (compliant or merely expiring soon) clears the task.
 *  A cert that is on file but waiting on a compliance manager reads as in progress: the
 *  member has done their part and re-uploading would not help. IN_PROGRESS still fails
 *  isSatisfied, so the gate is unchanged; only what the member is told changes. */
export function deriveHipaaTaskState(status: ComplianceStatus): OnboardingTaskState {
  if (status === "COMPLIANT" || status === "EXPIRING_SOON") return "COMPLETE";
  if (status === "PENDING_VERIFICATION" || status === "UNKNOWN_DATE") return "IN_PROGRESS";
  return "INCOMPLETE";
}
```

- [ ] **Step 4: Run the tests again**

Run: `npx vitest run src/modules/onboarding/engine/status.test.ts`
Expected: all pass.

- [ ] **Step 5: Run the onboarding service tests, which consume this**

Run: `npx vitest run src/modules/onboarding`
Expected: all pass. If a test asserts the old INCOMPLETE for a pending certificate, read it before changing it: if it asserts gate behavior it must keep passing untouched; if it asserts the displayed state it should move to IN_PROGRESS.

- [ ] **Step 6: Commit**

```bash
npx eslint src/modules/onboarding && npm run typecheck
git add src/modules/onboarding/engine/status.ts src/modules/onboarding/engine/status.test.ts
git commit -m "fix(onboarding): a pending HIPAA certificate reads as in progress, not incomplete"
```

---

### Task 2: Stop the checklist telling them to upload what they already uploaded

**Files:**
- Modify: `src/modules/onboarding/services/step-config.ts` (`StepDefault` type at `:14-25`, the `hipaa` entry at `:43-50`, `EffectiveStep` at `:84-96`, `effective()` at `:105-118`)
- Modify: `src/modules/onboarding/services/onboarding.ts` (`buildTask` at `:87-103`)
- Test: `src/modules/onboarding/services/onboarding.test.ts`

**Interfaces:**
- Consumes: `IN_PROGRESS` for the `hipaa` key, from Task 1.
- Produces: a task whose `description` and `ctaLabel` differ when `state === "IN_PROGRESS"`.

**Design note you need before writing code.** `description` is term-configurable: an admin can override it per term through `TermOnboardingStep`, and `effective()` resolves `row?.description ?? d.description`. `ctaLabel` and `href` are NOT configurable.

The pending copy must win over a term override. An override describes what the step *is* ("Upload your current HIPAA certificate so we can verify it"); the pending copy describes what the system is *currently doing*. Leaving an override in place during the pending state reproduces exactly the bug being fixed. So apply the pending copy in `buildTask`, after `effective()` has resolved, rather than inside the override merge.

- [ ] **Step 1: Add the pending copy to the defaults**

In `src/modules/onboarding/services/step-config.ts`, add two optional fields to `StepDefault` (after `ctaLabel`):

```ts
  /** Copy shown while the step is IN_PROGRESS, when the generic description
   *  would misdescribe the state. Applied in buildTask AFTER term overrides
   *  resolve, because an override describes the step and this describes what
   *  the system is currently doing. Only hipaa needs it today. */
  inProgressDescription?: string;
  inProgressCtaLabel?: string;
```

Add the same two fields to `EffectiveStep` (it mirrors `StepDefault`), and carry them through `effective()` alongside `ctaLabel`:

```ts
    inProgressDescription: d.inProgressDescription,
    inProgressCtaLabel: d.inProgressCtaLabel,
```

Then fill them in on the `hipaa` entry of `STEP_DEFAULTS`:

```ts
  hipaa: {
    label: "HIPAA certificate",
    description: "Upload your current HIPAA certificate so we can verify it is valid through the term.",
    order: 1,
    blocking: true,
    href: "/get-started/hipaa",
    ctaLabel: "Upload certificate",
    inProgressDescription: "We have your certificate. A compliance manager is confirming the date.",
    inProgressCtaLabel: "View certificate",
  },
```

- [ ] **Step 2: Apply it in buildTask**

In `src/modules/onboarding/services/onboarding.ts`, inside `buildTask`, replace the returned `task` object's `description` and `ctaLabel` lines:

```ts
    const inProgress = state === "IN_PROGRESS";
    return {
      task: {
        key,
        state,
        blocking: s.blocking,
        label: s.label,
        description: (inProgress && s.inProgressDescription) || s.description,
        href: s.href,
        ctaLabel: (inProgress && s.inProgressCtaLabel) || s.ctaLabel,
        reviewable: s.reviewable,
      },
      order: s.order,
    };
```

Steps without pending copy are unaffected, because the fields are undefined and the `||` falls through.

- [ ] **Step 3: Write a test for the swap**

Add to `src/modules/onboarding/services/onboarding.test.ts`, following the file's existing setup conventions for building a person with a term membership. Seed a certificate with a `completionDate` and `verifiedAt: null` so it resolves to `PENDING_VERIFICATION`, then assert:

```ts
it("tells a member with a pending certificate that we have it, not to upload it", async () => {
  // ... existing helpers to create person + active term + membership ...
  const status = await getOnboardingStatus(personId);
  const hipaa = status.tasks.find((t) => t.key === "hipaa");
  expect(hipaa?.state).toBe("IN_PROGRESS");
  expect(hipaa?.description).toBe("We have your certificate. A compliance manager is confirming the date.");
  expect(hipaa?.ctaLabel).toBe("View certificate");
  // The gate is unchanged: still not onboarded.
  expect(status.onboarded).toBe(false);
});
```

Read the file's existing tests first and match how they construct fixtures; do not invent a new helper.

- [ ] **Step 4: Run it**

Run: `npx vitest run src/modules/onboarding`
Expected: all pass.

- [ ] **Step 5: Verify the rendering needs no change**

Read `src/app/get-started/onboarding-checklist.tsx:37-46` and `:48-98`. Confirm, and note in your report, that `StatusPill` already renders `IN_PROGRESS` as `<Badge tone="brand">In progress</Badge>` and `TaskRow` already picks the `outline` button variant for any non-INCOMPLETE state. **No change to this file is expected.** If you believe one is needed, stop and report rather than editing it.

- [ ] **Step 6: Commit**

```bash
npx eslint src/modules/onboarding && npm run typecheck
git add src/modules/onboarding/services/step-config.ts src/modules/onboarding/services/onboarding.ts src/modules/onboarding/services/onboarding.test.ts
git commit -m "fix(onboarding): checklist explains the verification wait instead of asking for a re-upload"
```

---

### Task 3: Explain the wait on the /my-info panel

**Files:**
- Modify: `src/modules/my-info/components/hipaa-panel.tsx:104-110` and the "Upload New Certificate" section beginning at `:117`

**Interfaces:**
- Consumes: nothing from earlier tasks. `status` is already in scope in this component.

- [ ] **Step 1: Widen the reassurance condition and branch the copy**

The current block at `:104-110` renders only when the parser failed:

```tsx
{latest.completionDate === null && (
  <p className="mt-2 text-sm text-muted-foreground">
    A compliance manager will verify the completion date. No action is needed from you.
  </p>
)}
```

Replace it with a branch on `status`, so the normal case gets an explanation too:

```tsx
{status === "UNKNOWN_DATE" && (
  <p className="mt-2 text-sm text-muted-foreground">
    We could not read a completion date from this file, so a compliance manager will
    set it. No action is needed from you.
  </p>
)}
{status === "PENDING_VERIFICATION" && (
  <p className="mt-2 text-sm text-muted-foreground">
    We have your certificate and read a completion date of{" "}
    {latest.completionDate ? formatCalendarDate(latest.completionDate) : "the date on the file"}.
    A compliance manager confirms it before you are cleared. We will let you know when that
    happens, and you do not need to upload it again.
  </p>
)}
```

`formatCalendarDate` is already imported in this file (it is used at `:99`).

**Copy caveat, from the spec's risks.** The audit proposed adding "usually within a few days". That is an operational promise this repo cannot verify, so it is deliberately omitted. Do not add it. If Jack wants a timeframe he will add one in review.

- [ ] **Step 2: Add the support fallback**

Below the PENDING_VERIFICATION paragraph, add a line pointing at support for a wait that runs long. Use the existing `SupportLink` component and `getSupportContact()` rather than any hardcoded address. Read how another surface does this first (`src/app/login/page.tsx` renders `SupportLink` in its "Trouble signing in?" line) and follow that pattern, including how the contact reaches a client component.

If `hipaa-panel.tsx` is a client component and the contact is not already a prop, thread it from the server page rather than importing settings into the client. Report which approach you took.

- [ ] **Step 3: Demote the re-upload section while a certificate is under review**

The "Upload New Certificate" section at `:117` currently renders unconditionally, making re-uploading the visually obvious next step during a wait where it does nothing.

While `status === "PENDING_VERIFICATION" || status === "UNKNOWN_DATE"`, wrap that section in a collapsed `<details>` with a summary reading "Replace this certificate". Leave it fully expanded in every other status, including `EXPIRED` and `NO_CERTIFICATE`, where uploading IS the right next action.

Do not remove the section or gate it behind a permission. A member who uploaded the wrong file must still be able to fix it.

- [ ] **Step 4: Verify by eye**

Bring the environment up per the audit's method (native Postgres on 5434, dedicated database, `npm run dev`), sign in as a persona whose certificate is `PENDING_VERIFICATION`, and load `/my-info`. Confirm the explanation renders, the support link resolves, and the upload section is collapsed behind the disclosure.

If no such persona exists in your database, create one by setting `completionDate` on a certificate and clearing `verifiedAt`. Say in your report which persona you used and what you observed.

- [ ] **Step 5: Commit**

```bash
npx eslint src/modules/my-info && npm run typecheck
git add src/modules/my-info/components/hipaa-panel.tsx
git commit -m "fix(my-info): explain the certificate verification wait to the person waiting"
```

---

### Task 4: Add the email template for the verified notification

**Files:**
- Modify: `src/platform/email/templates/compliance.ts` (context builder near `:186-206`, descriptor appended to `complianceDescriptors` ending at `:342`)

**Interfaces:**
- Produces: `complianceCertVerifiedContext({ volunteerName, myInfoLink })` and a `compliance-cert-verified` descriptor. Task 5 renders through both.

- [ ] **Step 1: Add the context builder**

After `complianceVerificationReviewContext` in `src/platform/email/templates/compliance.ts`:

```ts
/** Params for the member-facing "your certificate is verified" email. */
export type ComplianceCertVerifiedParams = {
  volunteerName: string;
  myInfoLink: string;
};

/**
 * Build the context for the compliance-cert-verified template, sent to the
 * certificate OWNER when a manager verifies it. Every other compliance template
 * in this file is manager-facing; this one closes the loop back to the member,
 * who is blocked by the gate until this happens.
 */
export function complianceCertVerifiedContext(p: ComplianceCertVerifiedParams): Record<string, unknown> {
  return {
    volunteerName: p.volunteerName,
    myInfoLink: p.myInfoLink,
  };
}
```

- [ ] **Step 2: Add the descriptor**

Append to the `complianceDescriptors` array, matching the shape of its siblings exactly:

```ts
  {
    key: "compliance-cert-verified",
    name: "Compliance: certificate verified (member)",
    category: "transactional",
    group: "compliance",
    variables: [
      { name: "volunteerName", label: "Volunteer name", sampleValue: "Jane Doe" },
      {
        name: "myInfoLink",
        label: "Link to the member's own info page",
        sampleValue: "https://hub.havenfreeclinic.org/my-info",
      },
    ],
    defaultSubject: "[HAVEN] Your HIPAA certificate is verified",
    defaultBody: `<p>Hi {{ volunteerName }},</p>

<p>A compliance manager has confirmed your HIPAA certificate. Nothing further is needed from you for this requirement.</p>

<p><a href="{{ myInfoLink }}">View your certificate</a></p>

<p>Thank you,<br>HAVEN Free Clinic</p>`,
  },
```

The template engine supports only `{{#if}}`, `{{var}}`, and `{{{raw}}}`. It does NOT support `{{#each}}`. This template needs none of them beyond `{{var}}`.

- [ ] **Step 3: Verify the descriptor is picked up**

Run: `npx vitest run src/platform/email`
Expected: all pass. If a test asserts the descriptor count or the full key list, update it to include the new key.

- [ ] **Step 4: Commit**

```bash
npx eslint src/platform/email && npm run typecheck
git add src/platform/email/templates/compliance.ts
git commit -m "feat(email): add the member-facing certificate-verified template"
```

---

### Task 5: Tell the member when their certificate clears

**Files:**
- Modify: `src/platform/notifications/registry.ts` (`NOTIFICATION_TYPES` array)
- Modify: `src/platform/compliance/review-notifications.ts` (new helper alongside the two existing ones)
- Modify: `src/modules/volunteers/services/compliance.ts` (`verifyCertificate`, the `if (!cert.verifiedAt)` block at `:527-535`)
- Test: `src/modules/volunteers/services/compliance.test.ts`

**Interfaces:**
- Consumes: `complianceCertVerifiedContext` and the `compliance-cert-verified` descriptor from Task 4.
- Produces: `notifyCertVerified(db, volunteer: { id, name })`, called once on the not-verified to verified transition.

- [ ] **Step 1: Register the notification type**

In `src/platform/notifications/registry.ts`, add to `NOTIFICATION_TYPES` next to the other compliance entries:

```ts
  { key: "compliance-cert-verified", label: "HIPAA certificate verified (member)", defaultChannel: "email" },
```

`defaultChannel` is `"email"` for the reason the file's own comment gives: every type defaults to email so behavior is unchanged on first deploy. An admin can re-route it in `/admin/notifications`.

- [ ] **Step 2: Write the helper**

In `src/platform/compliance/review-notifications.ts`, add `complianceCertVerifiedContext` to the existing import from `@/platform/email/templates/compliance`, then add:

```ts
/**
 * Tell a volunteer their HIPAA certificate has been verified.
 *
 * The two helpers above notify managers that something needs their attention.
 * This one closes the loop back: until a manager verifies, the onboarding gate
 * blocks the member from every page, and before this existed the only way to
 * learn they were cleared was to keep signing in and checking.
 */
export async function notifyCertVerified(
  db: Db,
  volunteer: { id: string; name: string; entraObjectId: string | null; contactEmail: string | null },
): Promise<void> {
  const baseUrl = await getSetting<string>("app.baseUrl");
  const myInfoLink = `${baseUrl}/my-info`;
  const rendered = await renderEmail(
    "compliance-cert-verified",
    complianceCertVerifiedContext({ volunteerName: volunteer.name, myInfoLink }),
  );

  await notify(db, {
    type: "compliance-cert-verified",
    person: {
      id: volunteer.id,
      entraObjectId: volunteer.entraObjectId,
      contactEmail: volunteer.contactEmail,
    },
    email: { subject: rendered.subject, html: rendered.html },
    teams: {
      title: "Your HIPAA certificate is verified",
      summary: "A compliance manager confirmed your HIPAA certificate. Nothing further is needed for this requirement.",
      link: myInfoLink,
    },
  });
}
```

Note this one takes the full person shape rather than looking recipients up by permission, because the recipient is known.

- [ ] **Step 3: Call it on the transition**

In `src/modules/volunteers/services/compliance.ts`, inside `verifyCertificate`'s existing `if (!cert.verifiedAt)` block, after the `captureEvent` call:

```ts
    // Close the loop back to the member. The certificate is already durably
    // updated and audited, so a notification failure must not surface to the
    // manager as a failed verification. Same isolation as saveCertificate's
    // manager alerts.
    try {
      const owner = await prisma.person.findUnique({
        where: { id: cert.personId },
        select: { name: true, entraObjectId: true, contactEmail: true },
      });
      if (owner) {
        await notifyCertVerified(prisma, {
          id: cert.personId,
          name: owner.name,
          entraObjectId: owner.entraObjectId,
          contactEmail: owner.contactEmail,
        });
      }
    } catch (err) {
      log.error("[compliance] failed to notify member of certificate verification", errorAttrs(err, { certId }));
    }
```

Add the imports this needs. Check whether `log` and `errorAttrs` are already imported in this file; if not, import them from `@/platform/logging` following how `src/modules/my-info/services/my-info.ts` does it.

- [ ] **Step 4: Write the tests**

Add to `src/modules/volunteers/services/compliance.test.ts`, matching its existing fixture conventions:

```ts
it("notifies the member when their certificate is verified", async () => {
  // ... create owner + manager, cert with completionDate and verifiedAt: null ...
  await verifyCertificate(managerId, certId);
  const logs = await prisma.emailLog.findMany({ where: { template: "compliance-cert-verified" } });
  expect(logs).toHaveLength(1);
  expect(logs[0].personId).toBe(ownerId);
});

// The guard is `if (!cert.verifiedAt)`. A second verify must be a no-op for
// notifications, or a manager re-clicking spams the member.
it("does not notify again when an already-verified certificate is verified", async () => {
  // ... same setup ...
  await verifyCertificate(managerId, certId);
  await verifyCertificate(managerId, certId);
  const logs = await prisma.emailLog.findMany({ where: { template: "compliance-cert-verified" } });
  expect(logs).toHaveLength(1);
});
```

Read the file's existing tests first for how it builds people and certificates, and how it asserts on queued email. If it already has an `EmailLog` assertion helper, use that rather than querying directly.

- [ ] **Step 5: Run them and watch the second one matter**

Run: `npx vitest run src/modules/volunteers/services/compliance.test.ts`
Expected: both pass. If the second fails with 2 logs, the notification call was placed outside the `if (!cert.verifiedAt)` block. Move it inside.

- [ ] **Step 6: Run the wider suites this touches**

Run: `npx vitest run src/platform/notifications src/platform/compliance src/modules/volunteers`
Expected: all pass. If a test asserts the length of `NOTIFICATION_TYPES` or enumerates every key, update it for the new entry.

- [ ] **Step 7: Commit**

```bash
npx eslint src && npm run typecheck
git add src/platform/notifications/registry.ts src/platform/compliance/review-notifications.ts src/modules/volunteers/services/compliance.ts src/modules/volunteers/services/compliance.test.ts
git commit -m "fix(compliance): tell the member when their certificate is verified"
```

---

## Self-review notes

**Spec coverage.** Design section 1 maps to Tasks 1 and 2; section 2 to Task 3; section 3 to Tasks 4 and 5. The spec's testing section maps to Task 1 Step 1 (all six statuses plus the gate-unchanged regression), Task 2 Step 3 (copy swap plus gate unchanged), and Task 5 Step 4 (notify once, and not twice). The spec's failure-isolation requirement maps to Task 5 Step 3's try/catch.

**Deliberate deviation from the source finding.** R18 proposes telling members verification takes "usually within a few days". Task 3 Step 1 omits it and says why: this repo has no basis for that number, and it is the kind of sentence people hold you to. Flagged in the spec's risks for Jack to decide in review.

**Where this plan defers detail.** Three steps direct the implementer to read existing conventions before writing rather than prescribing exact code: Task 2 Step 3 and Task 5 Step 4 (test fixture construction, which differs per file and would be invented wrongly here) and Task 3 Step 2 (how `SupportLink` receives its contact in a client component). Each names the specific file to read. This is deliberate: prescribing fixture code for files I have not read would produce confident, wrong tests.
