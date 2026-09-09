import { Badge } from "./badge";
import type { StatusLabel } from "@/platform/compliance/labels";

/**
 * A Badge rendered straight from the shared status vocabulary.
 *
 * The label helpers in platform/compliance/labels all return `{ label, tone }`,
 * and every caller was unpacking that pair by hand to feed a Badge. This closes
 * the loop so a status can be rendered as `<StatusBadge {...someLabel(x)} />`
 * and there is no call site left where the tone and the words can be wired to
 * different statuses.
 *
 * StatusTone is a subset of the Badge tones on purpose: a status is never
 * "brand", which is reserved for identity rather than judgement.
 */
export function StatusBadge({ label, tone, title }: StatusLabel & { title?: string }) {
  // nowrap because these are two- and three-word labels in narrow table columns,
  // and a status folded across two lines ("No / certificate") reads as two
  // statuses. The column widens to fit instead.
  //
  // `title` is for a status whose SOURCE is not obvious from the words -- the
  // training roster reads an accepted applicant's certificate off their
  // onboarding contract, so "Needs verification" is about a document that is not
  // on any Person yet. It never carries the status itself: hover text nobody
  // opens must not be the only place a fact is stated.
  return (
    <Badge tone={tone} title={title} className="whitespace-nowrap">
      {label}
    </Badge>
  );
}
