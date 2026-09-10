import { TD } from "@/platform/ui/table";
import { TextLink } from "@/platform/ui/text-link";
import { formatPhone } from "@/platform/phone";

/**
 * The name cell shared by the three staff rosters that list people.
 *
 * The contact identity sits under the name rather than in columns of its own:
 * /volunteers and /volunteers/master already run eleven columns wide, and "how
 * do I reach this person" is the question that follows "are they cleared".
 *
 * /volunteers, /volunteers/master and /volunteers/directory are one click apart
 * and all link to the SAME profile, and they had this cell written out three
 * times, byte-identical in the subline. They had already disagreed about one
 * thing: directory renders "No contact details on file" when a person has no
 * NetID, email or phone, and the two compliance rosters rendered an empty span,
 * which reads as a render bug rather than as missing data. Directory's string
 * wins here, so all three say it.
 *
 * `person` is typed STRUCTURALLY rather than as Prisma's `Person`: the
 * compliance rosters pass a full Person row and directory passes its own
 * DirectoryPerson shape, and the structural type is what admits both.
 */
export function PersonNameCell({
  person,
  href,
}: {
  person: {
    name: string;
    netId: string | null;
    contactEmail: string | null;
    phone: string | null;
  };
  /**
   * Omit or pass null to render the name unlinked. /volunteers/directory is
   * readable by people without profile access, and an unlinked name is what
   * they get; the two compliance rosters always link, because every row on them
   * is by construction inside the viewer's own scope.
   */
  href?: string | null;
}) {
  const contact = [person.netId, person.contactEmail, formatPhone(person.phone)].filter(Boolean).join(" · ");
  return (
    <TD className="font-medium">
      {href ? <TextLink href={href}>{person.name}</TextLink> : person.name}
      <span className="block text-xs font-normal text-subtle-foreground break-words [overflow-wrap:anywhere]">
        {contact || "No contact details on file"}
      </span>
    </TD>
  );
}
