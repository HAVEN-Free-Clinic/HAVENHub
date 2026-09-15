import { redirect } from "next/navigation";

/** Moved with the rest of Subcommittees; see ../page.tsx. */
export default function NewSubcommitteeMovedRedirect() {
  redirect("/recruitment/subcommittees/new");
}
