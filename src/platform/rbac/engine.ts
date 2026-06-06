/**
 * Stub — real implementation lands in the RBAC engine task.
 * WARNING: always-deny. Do not wire requirePermission into any rendered
 * route until this is replaced, or every visit redirects to /hub.
 */
export async function can(_personId: string, _permission: string): Promise<boolean> {
  return false;
}
