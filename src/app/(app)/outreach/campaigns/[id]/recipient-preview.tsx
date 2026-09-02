"use client";

import { useState, useTransition } from "react";
import type { AudiencePreview, RecipientReason } from "@/platform/email/campaigns/service";
import type { PersonSearchHit } from "@/platform/email/audience/resolve";
import { Alert } from "@/platform/ui/alert";
import { Button } from "@/platform/ui/button";
import { Card } from "@/platform/ui/card";
import { Input, Textarea, Field } from "@/platform/ui/input";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { SubmitButton } from "./submit-button";
import { useFormDirty } from "./use-form-dirty";

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
 * Unlike those two, this panel must NOT be remounted to reset that guard: it
 * holds text the sender has typed and not saved. Keyed on updatedAt, clicking
 * Exclude on one row silently threw away a whole pasted block, because every
 * manual-list action bumps updatedAt. The reset therefore arrives as the
 * `savedAt` prop and the panel reconciles across the soft nav instead.
 *
 * That is necessary and not sufficient, which is worth knowing before anyone
 * simplifies it. Measured on the real page: a server action that redirects
 * replaces the ENTIRE page tree on some paths (Add and Save-addresses do, with
 * no full page load and no error; Exclude does not), and nothing a component
 * can do survives that -- an uncontrolled DOM value and React state die
 * together. So the paste box ALSO disables every control here that navigates
 * while it holds anything unsaved. The two together are what make the text
 * safe; either alone leaves a click that destroys it.
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
   * and the paste box below is an uncontrolled textarea whose half-typed
   * contents would go with it.
   */
  savedAt: string;
  preview: AudiencePreview;
  /** How many ids are in excludePersonIds. Deliberately a count and not a roll: see clearExcludedAction. */
  excludedCount: number;
  pastedText: string;
  searchAction: (query: string) => Promise<PersonSearchHit[]>;
  includeAction: FormAction;
  excludeAction: FormAction;
  clearExcludedAction: () => void | Promise<void>;
  pastedEmailsAction: FormAction;
}) {
  const dirty = useFormDirty(formId, savedAt);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PersonSearchHit[] | null>(null);
  const [searching, startSearch] = useTransition();

  /**
   * The paste box, held in state so the panel can tell whether it holds
   * anything the server has not got yet.
   *
   * `savedAt` keeps this panel from remounting on the actions it can see
   * coming, but that is not enough on its own: a server action that redirects
   * replaces the whole page tree on some paths (Add and Save-addresses do,
   * Exclude does not), and no in-component technique survives that -- neither
   * an uncontrolled DOM value nor this state. So unsaved text also DISABLES
   * every control here that navigates. Together the two mean a half-typed block
   * of addresses cannot be thrown away by a click somewhere else in the panel.
   */
  const [pastedDraft, setPastedDraft] = useState(pastedText);
  const pastedUnsaved = pastedDraft !== pastedText;
  // Anything that posts and navigates. The paste box's OWN save is deliberately
  // not in here: it is the way out.
  const navigatingDisabled = dirty || pastedUnsaved;

  function runSearch() {
    if (query.trim().length < MIN_SEARCH_LENGTH) return;
    startSearch(async () => setResults(await searchAction(query)));
  }

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
        <form action={pastedEmailsAction} className="space-y-3">
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
        </form>

        {pastedUnsaved && (
          <Alert tone="warning">
            Save or discard these addresses first. Excluding, adding and restoring all reload
            the page, and anything typed here that has not been saved would go with it.
          </Alert>
        )}

        <UnresolvedPastedAddresses addresses={preview.unresolved} />
      </Card>
    </div>
  );
}
