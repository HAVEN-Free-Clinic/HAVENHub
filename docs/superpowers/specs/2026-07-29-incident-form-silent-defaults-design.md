# The incident form's two silent defaults (2026-07-29)

## Problem

`/incidents` is where someone reports a colleague. It is the one form in the app where being wrong
about what happens next has consequences outside the software. It currently makes two decisions on
the reporter's behalf without telling them.

**It never says who reads the report, and its one disclosure statement is narrower than a reporter
will read it.** Section 10 shows "Your name: Dev Volunteer" and a single checkbox: "I would prefer
to remain anonymous (your name is not shared with the subject)". What actually happens is that the
report fans out to every holder of `incidents.manage`, the reporter's real name renders verbatim on
the detail page each of them opens, and the review queue's search box matches on reporter name. So
"anonymous" means anonymous to exactly one named party, and the person deciding whether it is safe
to report a colleague is told nothing about the set of people who will read their name. That
audience is described nowhere: not on the form, not on the confirmation, not on the detail page.

**It pre-answers the safety question as "No".** On a clean page load
`input[name=immediateRisk][value=no]` is checked, from a `defaultChecked`. The action reads
`immediateRisk: formData.get("immediateRisk") === "yes"`, and that flag is exactly what selects
between "was submitted and flagged as an immediate risk" and plain "was submitted" in both the
reviewer email and the Teams card. Section 6 sits well down a form measured at 1682px in an 861px
viewport, so it is below the fold on arrival. A reporter who never scrolls there silently submits a
de-escalation, and the reviewer is told the reporter said so.

Audit findings **R9** (F-08-1) and **R10** (F-08-2), PR #474. Both `blocks`, both tier 1.

## Goals

Tell the reporter who will read their name, and stop answering the safety question for them.

## Non-goals

- Changing who can read a report, or the `incidents.manage` permission model.
- Making the report genuinely anonymous to reviewers. That is a different feature with real
  tradeoffs (a reviewer usually needs to talk to the reporter), and the fix here is to describe the
  system honestly, not to change it.
- Any change to how strikes, escalation, or notification routing work.

## Design

### 1. Name the audience before the checkbox

Render an explicit disclosure block above the checkbox, stating that the report goes to the
clinic's incident reviewers, how many people that is, and that they see the reporter's name whether
or not the box is checked.

`peopleWithAnyPermission(["incidents.manage"])` is already called on submit
(`src/modules/incidents/services/report.ts:238`), so the page can call it to render the count.

Then relabel the checkbox to what it actually does: **"Do not share my name with the person I am
reporting."** The current label invites the reading "nobody will know it was me", which is false.

Mirror the same sentence on `/incidents/[id]` beside the Anonymity field, so a reporter can
re-read the promise later and a reviewer sees the same statement the reporter was given.

**Two things the audit's proposed wording gets wrong, and this deviates on:**

- It says "{n} people who hold the incidents.manage permission". Do not put a permission key in
  front of a volunteer. Say "the clinic's incident reviewers" and give the count.
- It assumes the count is positive. If no one holds the permission, the report reaches nobody, and
  the copy must not read "0 people". Decide and implement that branch deliberately: at minimum the
  block should not claim an audience that does not exist. Whether the form should also warn the
  reporter, or block submission, is an ops question worth raising rather than guessing.

### 2. Stop pre-answering the safety question

Remove `defaultChecked` from the "No" radio so nothing is submitted on the reporter's behalf.

**Make the question required with the native HTML `required` attribute, not with server-side
validation.** This is a deviation from the audit's fix, which said "make the question required"
without naming a mechanism, and the mechanism is the whole risk here.

`src/app/(app)/incidents/actions.ts:80` handles a validation failure with
`redirect("/incidents?error=validation&message=...")`, and the page renders that as a single
`Alert` at the top with no field targeting. A redirect re-renders the form empty. So a reporter who
writes several paragraphs about a colleague's conduct and misses one radio below the fold would
lose all of it. That is a strictly worse outcome than the bug being fixed.

The native attribute keeps the failure client-side: the browser blocks submission, focuses the
unanswered group, and nothing is lost. `required` on one input of a radio group makes the group
required.

A server-side check is acceptable as a backstop for a caller that bypasses the browser, but it must
not be the primary mechanism, and if it fires its message must name the field rather than saying
"validation".

If ops later wants a default, it has to be "Yes". A default that quietly downgrades urgency is the
defect; a default that quietly escalates is merely noisy.

## Consequences

**Every reporter must now answer one more question.** That is the point. It is one radio on a form
that already has ten sections, and it is the field that decides whether a reviewer is paged.

**The reviewer alert becomes trustworthy.** Today "was submitted" can mean either "the reporter
judged this routine" or "the reporter never saw the question". After this it means only the first.

## Testing

- The "No" radio is not checked on a clean load, and neither is "Yes".
- The radio group carries the native `required` attribute, so a submit with nothing selected is
  blocked by the browser rather than round-tripping. Assert the attribute; the browser behavior
  itself is not ours to test.
- A submitted "Yes" still produces the escalated reviewer copy, and a submitted "No" still produces
  the plain copy. This is the behavior the flag drives and it must not change.
- The disclosure block renders the reviewer count, and renders something sensible when the count is
  zero.
- The detail page shows the same disclosure sentence beside the Anonymity field.

## Risks

- **This is copy on a form about reporting colleagues.** Every string here is drafted to be edited
  in review. The one that matters most is the disclosure sentence, because a reporter will rely on
  it when deciding whether reporting is safe for them. If it overstates confidentiality it is worse
  than the current label.
- **The count is a live number rendered to a volunteer.** It is the number they need in order to
  judge the disclosure, and it exposes nothing about who those people are. But it does change as
  roles change, so it must be read at request time rather than cached into a build.
- **Requiring the field adds friction to a report someone may already be reluctant to file.** The
  native-attribute approach keeps that cost to one focused field rather than a lost draft, which is
  why the mechanism is specified rather than left open.
