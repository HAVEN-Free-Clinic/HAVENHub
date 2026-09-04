"use client";

import { useActionState, useState, useTransition } from "react";
import type { AudiencePreview, RecipientReason } from "@/platform/email/campaigns/service";
import type { PersonSearchHit } from "@/platform/email/audience/resolve";
import { Alert } from "@/platform/ui/alert";
import { Button } from "@/platform/ui/button";
import { Card } from "@/platform/ui/card";
import { Input, Textarea, Field } from "@/platform/ui/input";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { SubmitButton } from "./submit-button";
import { useFormDirty } from "./use-form-dirty";
import type { FormProblems } from "./form-state";

type FormAction = (formData: FormData) => void | Promise<void>;

/** How each recipient got into the roll, in the sender's words. */
const REASON_LABEL: Record<RecipientReason, string> = {
  matched: "Condition match",
  included: "Added by search",
  pasted: "Pasted address",
};

/**
 * Shortest query the Search button will run.
 *
 * Restated here rather than imported: MIN_SEARCH_LENGTH lives in
 * audience/resolve.ts, which reaches Prisma, and a value import would drag that
 * whole module into this client bundle. resolve.ts stays the authority -- it
 * refuses a shorter query on the server regardless of what this button does --
 * so the worst a drift between the two can cause is a request that comes back
 * empty.
 */
const MIN_SEARCH_LENGTH = 2;

/**
 * The pasted addresses that will not be emailed, with the one wording both
 * preview surfaces use.
 *
 * Shared between this panel and the Review tab's roll (audience-preview.tsx)
 * precisely so there is ONE wording to keep honest. It says nothing about
 * whether an address belongs to nobody or to a real person outside the
 * campaign's scope, and it must not learn to: distinguishing the two hands a
 * scoped sender an existence oracle over the whole directory, one address at a
 * time. The service computes the list the same way, by subtracting the roll
 * rather than by looking anyone up -- see unresolvedPastedAddresses in
 * campaigns/service.ts. Naming both possibilities in one sentence is the point:
 * the sender should read a missing address as "check the spelling, or check the
 * scope", never as "that person does not exist".
 */
export function UnresolvedPastedAddresses({ addresses }: { addresses: string[] }) {
  if (addresses.length === 0) return null;
  return (
    <Alert tone="warning">
      <p className="font-medium">
        {addresses.length} pasted address{addresses.length === 1 ? "" : "es"} will not be emailed:
      </p>
      <ul className="mt-1 list-disc pl-5">
        {addresses.map((address) => (
          <li key={address.toLowerCase()}>{address}</li>
        ))}
      </ul>
      <p className="mt-1">
        An address is listed here whether nobody has it or somebody outside this campaign&apos;s
        audience scope does. Check the spelling, and check the scope.
      </p>
    </Alert>
  );
}

/**
 * Who, exactly, this campaign is about to email, and the controls that nudge
 * that list.
 *
 * The roll here describes the SAVED campaign (the server resolved it before
 * this rendered), and every control below posts a server action that navigates.
 * Both are reasons to gate the whole panel on the compose form being clean, the
 * same guard ReviewActions and TimingActions use: acting while it is dirty
 * would edit a list against a stale roll, and the navigation would throw away
 * the unsaved condition edits on the way.
 *
 * THREE things keep that guard honest, and none of them is redundant.
 *
 * 1. The panel stays mounted for the whole life of the editor, including on the
 *    tabs where it shows nothing (`preview` is null off the Audience tab, and
 *    this returns null). useFormDirty is a listener seeded clean at mount, so a
 *    panel that mounted only when the roll arrived could not see an edit made
 *    before it: open on Compose, change the subject, click Audience, and the
 *    panel appeared with every control enabled. What the first click then threw
 *    away was not only the paste box, but TemplateEditor's subject and body and
 *    AudienceBuilder's entire audience tree, all of which are client state.
 * 2. The guard's reset arrives as the `savedAt` PROP, never as a `key`. Keyed on
 *    updatedAt, the panel remounted on every manual-list action, which both
 *    reset the guard and threw away a half-typed block of addresses.
 * 3. Unsaved text in the paste box ALSO disables every control here that
 *    navigates. Not a belt for 2's braces: on this route EVERY server-action
 *    redirect replaces the whole page tree below AppShell, and nothing a
 *    component can do survives that -- an uncontrolled DOM value and React
 *    state die together. See the comment on pastedDraft below.
 */
export function RecipientPreview({
  formId,
  savedAt,
  preview,
  excludedCount,
  pastedText,
  searchAction,
  includeAction,
  excludeAction,
  clearExcludedAction,
  pastedEmailsAction,
}: {
  formId: string;
  /**
   * The campaign's updatedAt, as an ISO string. Drives the compose-dirty reset
   * (see useFormDirty), and is deliberately a PROP rather than a `key` on this
   * component: keying it would remount the panel on every manual-list action,
   * and take the half-typed contents of the paste box with it.
   */
  savedAt: string;
  /**
   * The resolved roll, or null on the tabs that do not show one. Null is a
   * rendering state, NOT an excuse to unmount: the panel is mounted for the
   * whole life of the editor so its dirty guard sees edits made on other tabs.
   * Resolving a roll costs a full audience resolve, which is why the server
   * only does it for the Audience tab.
   */
  preview: AudiencePreview | null;
  /** How many ids are in excludePersonIds. Deliberately a count and not a roll: see clearExcludedAction. */
  excludedCount: number;
  pastedText: string;
  searchAction: (query: string) => Promise<PersonSearchHit[]>;
  includeAction: FormAction;
  excludeAction: FormAction;
  clearExcludedAction: () => void | Promise<void>;
  /**
   * Returns its problems rather than redirecting with them, for the reason in
   * form-state.ts: its only refusal is "too many addresses", and a redirect
   * would destroy the block it was complaining about.
   */
  pastedEmailsAction: (prevState: FormProblems, formData: FormData) => Promise<FormProblems>;
}) {
  const dirty = useFormDirty(formId, savedAt);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PersonSearchHit[] | null>(null);
  const [searching, startSearch] = useTransition();

  /**
   * The paste box, held in state so the panel can tell whether it holds
   * anything the server has not got yet.
   *
   * Not keeping this panel mounted is not enough on its own, because a server
   * action that redirects can replace the whole page tree below AppShell, and
   * no in-component technique survives that -- neither an uncontrolled DOM
   * value nor this state. So unsaved text also DISABLES every control here that
   * navigates.
   *
   * What that replacement is, measured rather than reasoned: the boundary is
   * the Suspense fallback from `(app)/loading.tsx` (its blast radius matches
   * exactly -- AppShell survives, everything under it is recreated, with no
   * document load -- and there is no nearer loading.tsx under outreach/). On
   * this route it is what every server-action redirect does: 6 of 6 replaced
   * the tree, while 2 of 2 tab Link navigations reconciled. Each of these
   * actions calls revalidatePath and redirects to the URL the sender is
   * already on, so each must refetch the segment and each commits the fallback.
   *
   * An earlier reading of this file called it a race and singled out Exclude as
   * the one that reconciles. That was one sample, since corrected by the wider
   * measurement: treat EVERY action redirect here as destroying client state.
   * Which makes the guard below load-bearing rather than defensive.
   */
  const [pastedDraft, setPastedDraft] = useState(pastedText);
  // Re-seeded whenever the SERVER's stored block changes, which is the only
  // thing that reliably means a paste was accepted. Comparing a typed string
  // with a stored one is not enough on its own: editManualLists splits on
  // commas and whitespace, trims, and dedupes, then the page joins with
  // newlines, so a successful save routinely hands back a different string from
  // the one that was typed. Without this the guard below latches on forever
  // after such a save, insisting the addresses are unsaved when they are
  // stored. Same render-time reset useFormDirty uses, and keyed on pastedText
  // rather than savedAt so an unrelated action cannot clear a real draft.
  const [seenPastedText, setSeenPastedText] = useState(pastedText);
  if (seenPastedText !== pastedText) {
    setSeenPastedText(pastedText);
    setPastedDraft(pastedText);
  }
  const pastedUnsaved = pastedDraft !== pastedText;
  // Anything that posts and navigates. The paste box's OWN save is deliberately
  // not in here: it is the way out.
  const navigatingDisabled = dirty || pastedUnsaved;

  // Mounted on every tab, rendered only where there is a roll to render. The
  // hooks above run either way, which is the entire point: see 1 in the doc
  // comment.
  const showPanel = preview !== null;

  const [pasteState, pasteFormAction] = useActionState(pastedEmailsAction, null);

  function runSearch() {
    if (query.trim().length < MIN_SEARCH_LENGTH) return;
    startSearch(async () => setResults(await searchAction(query)));
  }

  // AFTER every hook, never before one. This is the "mounted but showing
  // nothing" state, not an unmount.
  if (!showPanel) return null;

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold text-foreground">Recipients</h3>
        <p className="text-xs text-subtle-foreground">
          Everyone this campaign will email as it is saved now: the people your conditions
          match, plus anyone added below, minus anyone excluded. Manual additions are held to
          the same audience scope the conditions are.
        </p>
      </div>

      {dirty && (
        <Alert tone="warning">
          Save your changes before editing this list. It describes the last saved version of
          this campaign, and these controls reload the page.
        </Alert>
      )}

      <Card className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-sm font-medium text-foreground">
            {preview.count} recipient{preview.count === 1 ? "" : "s"}
          </p>
          <div className="flex flex-wrap items-baseline gap-3 text-xs text-muted-foreground">
            {preview.excludedNoEmail > 0 && (
              <span>
                {preview.excludedNoEmail} matched but {preview.excludedNoEmail === 1 ? "has" : "have"}{" "}
                no email address on file
              </span>
            )}
            {excludedCount > 0 && (
              <span className="flex items-baseline gap-2">
                {excludedCount} excluded by hand
                {/* The only undo for an exclude. All-or-nothing because naming the
                    excluded people would echo back a name for any id posted to
                    this page; see clearExcludedAction in actions.ts. */}
                <form action={clearExcludedAction}>
                  <SubmitButton variant="ghost" pendingLabel="Restoring..." disabled={navigatingDisabled}>
                    Restore all
                  </SubmitButton>
                </form>
              </span>
            )}
          </div>
        </div>

        {preview.count === 0 ? (
          /* Two different reasons for an empty roll, and the copy has to say
             which. "Check that every condition has a value" is actively
             misleading to a sender whose conditions matched fine and who then
             excluded everyone by hand: it sends them to edit a tree that is
             working, when the fix is one Restore away. */
          excludedCount > 0 ? (
            <Alert tone="warning">
              Nobody is left on this list. {excludedCount}{" "}
              {excludedCount === 1 ? "person was" : "people were"} excluded by hand; Restore all
              puts {excludedCount === 1 ? "them" : "them all"} back.
            </Alert>
          ) : (
            <Alert tone="warning">
              This audience matches nobody. An empty or incomplete condition deliberately matches
              no one rather than everyone, so check that every condition has a value.
            </Alert>
          )
        ) : (
          <div className="max-h-96 overflow-y-auto">
            <Table>
              <THead>
                <TR>
                  <TH>Name</TH>
                  <TH>Email</TH>
                  <TH>Why</TH>
                  <TH>
                    <span className="sr-only">Actions</span>
                  </TH>
                </TR>
              </THead>
              <tbody>
                {preview.sample.map((r) => (
                  <TR key={r.personId}>
                    <TD className="text-foreground-soft">{r.name}</TD>
                    <TD className="text-foreground-soft">{r.email}</TD>
                    <TD className="text-xs text-subtle-foreground">{REASON_LABEL[r.reason]}</TD>
                    <TD>
                      <form action={excludeAction}>
                        <input type="hidden" name="personId" value={r.personId} />
                        <SubmitButton variant="ghost" pendingLabel="Excluding..." disabled={navigatingDisabled}>
                          Exclude
                        </SubmitButton>
                      </form>
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          </div>
        )}

        {preview.truncated && (
          <p className="text-xs text-muted-foreground">
            Showing the first {preview.sample.length} of {preview.count}. The count above is exact.
          </p>
        )}
      </Card>

      {/* Manual include. The search is bounded by this campaign's scope on the
          server (see searchPeopleAction), so this box can only ever offer
          people the campaign could already mail. */}
      <Card className="space-y-3">
        <p className="text-sm font-medium text-foreground">Add someone</p>
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-full max-w-sm">
            <Field label="Search by name or email" hint="Only people inside this campaign's audience scope can be found.">
              <Input
                type="search"
                value={query}
                disabled={dirty}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    // Not inside a form, so Enter would otherwise do nothing at
                    // all; the search box is the one control here that is not a
                    // server action.
                    e.preventDefault();
                    runSearch();
                  }
                }}
              />
            </Field>
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={dirty || searching || query.trim().length < MIN_SEARCH_LENGTH}
            onClick={runSearch}
          >
            {searching ? "Searching..." : "Search"}
          </Button>
        </div>

        {results !== null && results.length === 0 && (
          // eslint-disable-next-line local/no-adhoc-empty-state -- deliberate text-xs in this dense preview panel; EmptyState is text-sm and this repo has no tailwind-merge, so the size override would be unreliable.
          <p className="text-xs text-muted-foreground">
            Nobody in this campaign&apos;s audience scope matches that.
          </p>
        )}

        {results !== null && results.length > 0 && (
          <ul className="divide-y divide-border">
            {results.map((p) => (
              <li key={p.personId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="text-sm text-foreground-soft">
                  {p.name} <span className="text-subtle-foreground">{p.email}</span>
                </span>
                <form action={includeAction}>
                  <input type="hidden" name="personId" value={p.personId} />
                  <SubmitButton variant="outline" pendingLabel="Adding..." disabled={navigatingDisabled}>
                    Add
                  </SubmitButton>
                </form>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Pasted addresses. Saved as a whole block, so removing one is an edit
          here rather than another control. */}
      <Card className="space-y-3">
        <form action={pasteFormAction} className="space-y-3">
          <Field
            label="Paste addresses"
            hint="One per line, or separated by commas. Held to the same audience scope as everything else."
            hintPosition="top"
          >
            <Textarea
              name="pastedEmails"
              rows={4}
              value={pastedDraft}
              onChange={(e) => setPastedDraft(e.target.value)}
              disabled={dirty}
              placeholder={"someone@example.com\nsomeone-else@example.com"}
            />
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <SubmitButton variant="outline" pendingLabel="Saving..." disabled={dirty}>
              Save addresses
            </SubmitButton>
            {pastedUnsaved && (
              // The way out of the guard that is not a save. Without it a sender
              // who typed something they did not want has to reconstruct the
              // stored text by hand before the rest of the panel works again.
              <Button type="button" variant="ghost" onClick={() => setPastedDraft(pastedText)}>
                Discard
              </Button>
            )}
          </div>

          {/* Rendered here rather than carried away in a redirect: the only
              refusal this action has is "too many addresses", and redirecting
              with it destroyed the block being complained about. */}
          {pasteState && <Alert tone="error">{pasteState.problems.join("; ")}</Alert>}
        </form>

        {pastedUnsaved && (
          // Two different states, and the first one used to be told to do
          // something it could not: while the compose form is dirty, Save
          // addresses is disabled too, so "save or discard" left only half a
          // sentence true.
          <Alert tone="warning">
            {dirty
              ? "These addresses cannot be saved while the compose form has unsaved changes, because either save reloads the page. Discard clears them, or copy them somewhere before you save your changes."
              : "Save these addresses, or discard them, before using the controls above. Excluding, adding, restoring and the compose form's own Save all reload the page, and anything typed here that has not been saved would go with it."}
          </Alert>
        )}

        <UnresolvedPastedAddresses addresses={preview.unresolved} />
      </Card>
    </div>
  );
}
