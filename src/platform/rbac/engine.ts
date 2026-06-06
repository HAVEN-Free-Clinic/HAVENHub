/** Stub — real implementation lands in the RBAC engine task. */
export async function can(_personId: string, _permission: string): Promise<boolean> {
  return false;
}
