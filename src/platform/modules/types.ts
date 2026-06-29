import type { ComponentType } from "react";

export type ModuleStatus = "active" | "coming-soon";

export type ModuleNavItem = {
  label: string;
  href: string;
  /**
   * Fine-grained permission the destination page enforces, when it requires
   * more than the module's accessPermission. MUST mirror the page's own
   * requirePermission(...) call so the nav never shows a tab that would bounce
   * the viewer. Omit when the page gates on module access only (the tab is then
   * shown to anyone who can enter the module).
   */
  permission?: string;
};

export type ModuleManifest = {
  /** URL segment and permission namespace, e.g. "schedule" → /schedule, "schedule.*" */
  id: string;
  title: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
  /**
   * Controls hub-tile visibility and the module's route guard. Optional:
   * when absent, the module is open to any signed-in matched person (no
   * permission required). My Info uses this so non-current members keep access.
   */
  accessPermission?: string;
  /** Every permission string this module declares; feeds the RBAC editor. */
  permissions: string[];
  status: ModuleStatus;
  nav: ModuleNavItem[];
};
