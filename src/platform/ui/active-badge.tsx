import { Badge } from "./badge";

/**
 * Whether a record is active, said the same way everywhere.
 *
 * Six record pages carried this state only as a checkbox inside their edit
 * form, so a director reading a deactivated department or a retired specialty
 * saw a page that looked exactly like a live one until they scrolled to the
 * form and noticed the box was clear. It belongs in the header, beside the
 * record's name, because it is part of what the record IS.
 *
 * A shared component rather than an inline Badge at each site: this is the
 * smallest possible vocabulary (two words, two tones) and it is precisely the
 * kind that drifts into "Inactive" / "Deactivated" / "Archived" one page at a
 * time.
 */
export function ActiveBadge({ active }: { active: boolean }) {
  return (
    <Badge tone={active ? "success" : "default"}>{active ? "Active" : "Inactive"}</Badge>
  );
}
