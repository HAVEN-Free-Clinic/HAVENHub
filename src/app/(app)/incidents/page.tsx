import { redirect } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import { can } from "@/platform/rbac/engine";

/**
 * The incidents module root: a redirect, not a page.
 *
 * This used to BE the concern form, which made it the one place in the app
 * where every up-link lands you in a half-built create screen. The module chip
 * in the toolbar, the "Incidents" breadcrumb on a report, and the tab row's
 * first tab all point at the module root, so a reviewer stepping back from
 * report #42 arrived at a blank Professional Standards Incident Report --
 * about the most alarming place to land by accident in this product, since an
 * abandoned form looks like a half-filed report. It also meant a reviewer had
 * no in-chrome route back to the queue at all.
 *
 * The form now lives at /incidents/new, like every other create route, and
 * this sends people where they were going. The branch mirrors
 * outreach/page.tsx: land on what this viewer actually came for.
 *
 * Gate: requirePersonSession only, matching the module (which declares no
 * accessPermission so anyone can file a report). Both destinations are open to
 * every signed-in person -- /incidents/mine unconditionally, /incidents/review
 * behind the same incidents.manage this branch tests -- so neither can bounce.
 */
export default async function IncidentsIndexPage() {
  const { personId } = await requirePersonSession();
  if (await can(personId, "incidents.manage")) redirect("/incidents/review");
  redirect("/incidents/mine");
}
