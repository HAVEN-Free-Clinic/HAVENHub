import type { ComponentType } from "react";

export type ModuleStatus = "active" | "coming-soon";

export type ModuleNavItem = {
  label: string;
  href: string;
};

export type ModuleManifest = {
  /** URL segment and permission namespace, e.g. "schedule" → /schedule, "schedule.*" */
  id: string;
  title: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
  /** Controls hub-tile visibility and the module's route guard. */
  accessPermission: string;
  /** Every permission string this module declares; feeds the RBAC editor. */
  permissions: string[];
  status: ModuleStatus;
  nav: ModuleNavItem[];
};
