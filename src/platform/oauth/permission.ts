import { can } from "@/platform/rbac/engine";
import type { McpResource } from "./config";

/** Whether this person may connect an app to the resource at all. */
export async function mayConnect(personId: string, resource: McpResource): Promise<boolean> {
  return resource.permission === null || can(personId, resource.permission);
}
