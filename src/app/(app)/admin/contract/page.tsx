import { redirect } from "next/navigation";

/**
 * The master onboarding contract moved to /recruitment/contract: it is the
 * template every new cycle's contract starts from, so it belongs beside the
 * cycles. This route stays for old links, and keeps ?track= so a link to the
 * director template still opens the director template.
 */
export default async function ContractMovedRedirect({
  searchParams,
}: {
  searchParams: Promise<{ track?: string | string[] }>;
}) {
  const { track } = await searchParams;
  redirect(typeof track === "string" ? `/recruitment/contract?track=${encodeURIComponent(track)}` : "/recruitment/contract");
}
