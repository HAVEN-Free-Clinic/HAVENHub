import { redirect } from "next/navigation";

/** Moved with the rest of Subcommittees; see ../page.tsx. */
export default async function SubcommitteeMovedRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/recruitment/subcommittees/${encodeURIComponent(id)}`);
}
