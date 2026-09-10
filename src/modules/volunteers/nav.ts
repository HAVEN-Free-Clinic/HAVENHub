/**
 * Which dynamically-gated volunteers tabs a given viewer can actually open.
 *
 * A thin module-level file rather than the (app) layout calling the platform
 * helper directly: it gives the layout one small surface to mock in tests, and
 * it puts the volunteers gate in the same shape as the schedule and recruitment
 * ones so `NAV_GATE_RESOLVERS` can list all three side by side.
 */

import { DUAL_ROLE_QUEUE_PATH, directsADualRoleDepartment } from "@/platform/dual-roles";

export { DUAL_ROLE_QUEUE_PATH };

/**
 * The dynamically-gated volunteers hrefs this person may open.
 *
 * Deliberately NARROWER than the page's own gate, which is
 * `requirePermission("volunteers.manage_dual_roles")` alone. Every director
 * holds that permission, but only the departments that ask the dual-role
 * question on the application can ever have a queue, so gating the tab on the
 * permission would offer it to every director in the clinic and land nearly all
 * of them on an empty page. Narrower is the safe direction: this can only hide
 * a tab someone could have opened, never offer one the page will bounce.
 *
 * ## Cost
 *
 * One `prisma.department.count` per authenticated page render, and only for
 * holders of volunteers.manage_dual_roles. `directsADualRoleDepartment`
 * short-circuits to false with zero queries for everyone else.
 *
 * Per RENDER, not per call: a volunteers page asks this twice, once for the
 * global nav dropdown and once for the tab row, and the gate is request-cached
 * so the second ask is free.
 */
export async function resolvedVolunteersNavHrefs(personId: string): Promise<Set<string>> {
  return (await directsADualRoleDepartment(personId)) ? new Set([DUAL_ROLE_QUEUE_PATH]) : new Set();
}
