import { redirect } from "next/navigation";

/**
 * The master view merged into /volunteers, the one compliance roster (see that
 * page). This route stays so the links already out there keep working --
 * bookmarks, and the review links sitting in managers' inboxes -- and it keeps
 * the query, so a filtered or next-term link lands on the same view.
 */
export default async function MasterViewRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) {
    if (typeof value === "string") params.set(key, value);
  }
  const query = params.toString();
  redirect(query ? `/volunteers?${query}` : "/volunteers");
}
