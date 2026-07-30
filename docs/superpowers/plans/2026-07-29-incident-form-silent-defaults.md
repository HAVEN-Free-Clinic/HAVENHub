# Incident Form Silent Defaults Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tell the reporter who will read their name, and stop answering the safety question on their behalf.

**Architecture:** Two independent changes to `/incidents`, plus one mirrored sentence on the detail page. No service, action, or notification logic changes.

**Tech Stack:** Next.js App Router server components, Vitest, Playwright MCP for the visual check.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-29-incident-form-silent-defaults-design.md`. Read it before Task 1.
- Source findings: PR #474, items **R9** (F-08-1) and **R10** (F-08-2). Both `blocks`, both tier 1.
- **No em-dashes anywhere, in prose or code.** CI enforces this via the `local/no-em-dash` eslint rule.
- **This is the form for reporting a colleague.** Every string is drafted to be edited in review. Do not invent claims about confidentiality, retention, or who acts on a report; state only what the code does.
- **No internal vocabulary in front of a volunteer.** Never render a permission key like `incidents.manage` on this page. Say "the clinic's incident reviewers".
- Do not change `src/app/(app)/incidents/actions.ts`, `src/modules/incidents/services/report.ts`, or any notification routing. This changes what the reporter is told and asked, not what the system does with it.
- Lint with `npx eslint src`. Plain `npm run lint` walks a gitignored design-system directory and produces noise. Run `npm run typecheck` before each commit.
- `main` carries 7 pre-existing storage and blob-cleanup test flakes. They are not yours.

## File structure

- Modify: `src/app/(app)/incidents/page.tsx` (both findings)
- Modify: `src/app/(app)/incidents/[id]/page.tsx` (the mirrored sentence)

---

### Task 1: Stop pre-answering the safety question

**Files:**
- Modify: `src/app/(app)/incidents/page.tsx:147-154` (section 6)
- Test: see Step 4

**Interfaces:**
- Produces: nothing Task 2 depends on. The two tasks are independent.

Current state at `:151-152`:

```tsx
<Radio name="immediateRisk" value="yes" label="Yes - needs urgent attention" />
<Radio name="immediateRisk" value="no" defaultChecked label="No - resolved or not time-sensitive" />
```

That `defaultChecked` is the whole bug. `actions.ts:70` reads `formData.get("immediateRisk") === "yes"`, and the resulting flag selects between "was submitted and flagged as an immediate risk" and plain "was submitted" in both the reviewer email and the Teams card (`report.ts:265-268`). Section 6 is below the fold on arrival, so a reporter who never scrolls there silently submits a de-escalation and the reviewer is told the reporter chose it.

- [ ] **Step 1: Remove the default and require the group natively**

Drop `defaultChecked`. Add the native `required` attribute so the browser blocks submission and focuses the group.

`Radio` spreads `...rest` onto the native `<input type="radio">` (`src/platform/ui/radio.tsx:14-18`), so `required` passes straight through. `required` on one input of a radio group makes the whole group required in HTML.

**Do NOT add server-side validation as the primary mechanism.** `actions.ts:80` handles a validation failure with `redirect("/incidents?error=validation&message=...")`, and the page renders that as a single `Alert` at the top (`page.tsx:96-99`) with no field targeting. A redirect re-renders the form empty, so a reporter who wrote several paragraphs about a colleague and missed one radio would lose all of it. That is strictly worse than the bug being fixed. The whole point of the native attribute is that the failure never reaches the server.

- [ ] **Step 2: Decide whether to add a server backstop, and say why**

A server-side check would only catch a caller that bypasses the browser. If you add one, its message must name the field rather than saying "validation", and it must not become the path a normal reporter hits.

Your call. State your reasoning in the report either way. Adding nothing is a defensible answer for a form that is only reachable from this page.

- [ ] **Step 3: Check for other submit paths to this action**

Grep for other callers of the report-submission action. If a seed script, a test, or another surface submits this form without `immediateRisk`, removing the default changes its behavior. Report what you found.

- [ ] **Step 4: Test what is testable**

The browser's own enforcement is not ours to test. Assert the markup:

```
- neither radio is checked on a clean render
- the group carries the native required attribute
```

Read the existing tests under `src/app/(app)/incidents/` and the repo's conventions for asserting on a server component's output. **If there is no established way to render-test this page, say so and verify in the browser at Step 5 instead of inventing a test harness.** An honest gap beats a bespoke setup nobody else uses.

- [ ] **Step 5: Verify in a browser**

`.env.local` does not exist in this worktree. Copy it from `/Users/jcarney/Documents/Code-Projects/HAVENHub/.claude/worktrees/fix+hipaa-verification-wait/.env.local`, which points at `havenhub_uxaudit` on localhost:5434. It is gitignored; never commit it.

Sign in as `dev.volunteer@yale.edu` and load `/incidents`. Confirm neither radio is preselected, and that submitting without answering is blocked by the browser with focus moving to section 6 rather than a page reload.

Start your own dev server with `run_in_background: true`; it dies with your session, which is fine. Use Playwright MCP; the Chrome extension is not connected.

- [ ] **Step 6: Commit**

```bash
npx eslint src && npm run typecheck
git add -A src
git commit -m "fix(incidents): stop pre-answering the ongoing-risk question"
```

---

### Task 2: Name the audience before the anonymity checkbox

**Files:**
- Modify: `src/app/(app)/incidents/page.tsx:184-192` (section 10)
- Modify: `src/app/(app)/incidents/[id]/page.tsx` (near the Anonymity field, reported at `:267`)

**Interfaces:**
- Consumes: nothing from Task 1.

Current state at `:187-191`: a `ReadonlyField` showing the reporter's name, then one checkbox labelled "I would prefer to remain anonymous (your name is not shared with the subject)".

What actually happens: the report fans out to every holder of `incidents.manage` (`report.ts:238`), the reporter's name renders verbatim on the detail page each of them opens (`[id]/page.tsx:267`), and the review queue's search matches on reporter name (`review/page.tsx:131`). So "anonymous" means anonymous to exactly one named party, and that is never stated.

- [ ] **Step 1: Get the reviewer count**

`peopleWithAnyPermission(permissions: string[]): Promise<PermissionHolder[]>` lives at `src/platform/rbac/holders.ts:25`. `/incidents/page.tsx` is a server component, so it can await it directly and use `.length`.

Two things to work out and report:

- It calls `getActiveTerm()` internally, so the count is term-scoped. Confirm that matches the audience `report.ts:238` actually notifies, since the disclosure must describe the real audience rather than a different query that happens to be nearby.
- Decide whether the reporter should be excluded from the count when they hold the permission themselves. "5 people will see your name" reading as 5 including you is slightly wrong. Other helpers in `src/platform/compliance/review-notifications.ts` filter the subject out of recipient lists; look at whether `report.ts:238` does the same, and match reality rather than inventing a rule.

- [ ] **Step 2: Render the disclosure block above the checkbox**

State that the report goes to the clinic's incident reviewers, how many people that is, and that they see the reporter's name whether or not the box is checked.

**Never render the permission key.** "the clinic's incident reviewers" is the phrase.

Draft the copy in HAVEN voice: sentence case, plain language, no em-dashes. Say only what the code does. Do not add claims about retention, who investigates, or how long anything takes; none of that is knowable from here.

- [ ] **Step 3: Handle a count of zero deliberately**

If nobody holds the permission the report reaches nobody, and the block must not read "0 people".

The spec flags whether the form should also warn the reporter, or refuse to submit, as an operational question rather than something to guess. **So: implement the copy branch so it never states a false audience, and do NOT add a warning or a submission block.** If you think one is needed, say so in your report and leave it for Jack.

- [ ] **Step 4: Relabel the checkbox**

Replace the current label with what the control actually does:

```
Do not share my name with the person I am reporting.
```

The existing label invites the reading "nobody will know it was me", which is false.

- [ ] **Step 5: Mirror the sentence on the detail page**

Add the same disclosure sentence beside the Anonymity field on `src/app/(app)/incidents/[id]/page.tsx` (reported around `:267`; verify the line). Two reasons: a reporter can re-read the promise they were given, and a reviewer sees the same statement rather than a different one.

Verify the line number before editing. This branch's predecessors found several audit line references had drifted.

- [ ] **Step 6: Verify in a browser**

As `dev.volunteer@yale.edu` on `/incidents`, confirm the block renders with a plausible count and the relabelled checkbox.

Then, as a persona holding `incidents.manage`, open a report's detail page and confirm the mirrored sentence appears beside the Anonymity field. `j.carney@yale.edu` is a Platform Admin with the `*` grant, so it will reach the detail page. Note in your report that you used an admin rather than a scoped reviewer, if so.

The audit left at least one incident report in `havenhub_uxaudit` filed by `dev.volunteer@yale.edu`, so a detail page should exist. If not, file one through the form.

- [ ] **Step 7: Commit**

```bash
npx eslint src && npm run typecheck
git add -A src
git commit -m "fix(incidents): name the reviewer audience before the anonymity checkbox"
```

---

## Self-review notes

**Spec coverage.** Design section 1 maps to Task 2; section 2 to Task 1. The spec's testing list maps to Task 1 Step 4 (markup assertions) and Task 2 Step 6 (the count and the mirrored sentence). The spec's zero-count risk maps to Task 2 Step 3, which deliberately scopes the fix to copy and leaves the ops decision open.

**The ordering is arbitrary and the tasks are independent.** Task 1 goes first because it is smaller and has the sharper correctness property. If Task 2 stalls, Task 1 is still worth shipping alone.

**Two steps hand a decision to the implementer**, each with the information to make it: Task 1 Step 2 (whether a server backstop is worth having, given the redirect discards the draft) and Task 2 Step 1 (whether to exclude the reporter from the count, resolved by reading what the notify path actually does).

**Not covered: whether "anonymous" should mean anonymous to reviewers too.** That is a real feature with real tradeoffs, since a reviewer usually needs to talk to the reporter. The spec names it as a non-goal. This plan describes the system honestly rather than changing it.
