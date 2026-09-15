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
   *
   * An array means ANY ONE of the listed permissions admits the viewer, and
   * MUST mirror a page gating on requireAnyPermission(...). It exists for tabs
   * serving two audiences at different strengths -- support "All requests" is
   * open both to a manager and to a view-only auditor -- where a single string
   * would force the weaker audience out of the nav even though the page admits
   * them.
   */
  permission?: string | string[];
  /**
   * True when the destination's real gate is a data-driven capability that no
   * permission string can express (e.g. "manages at least one schedule
   * department"), so the owning module layout resolves it and drops the tab
   * itself. The global nav cannot evaluate such a gate, so it omits these items
   * rather than risk offering a link that bounces to /no-access. Being
   * under-inclusive is safe here: the item is still one hop away on the module's
   * own page.
   */
  dynamicGate?: boolean;
  /**
   * Fold this page under another tab of the same module: the href of that tab.
   *
   * A folded page keeps everything that makes it findable -- its entry in the
   * global dropdown, its Cmd+K hit, its breadcrumb label -- but the module's own
   * tab row omits it and marks `underTab` active while you are on it. For a page
   * reached from its parent (Credentialing from Attendings) or used a few days a
   * year (Check in), rather than a peer that earns a permanent tab. It is the
   * answer to a tab row that had grown to eleven, not a way to hide a page:
   * dropping an item from the registry would lose the dropdown and Cmd+K too.
   *
   * Must name another item in the same module that is not itself folded
   * (guarded by registry.test.ts).
   */
  underTab?: string;
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
  /** Extra permissions that also grant module access, beyond accessPermission. */
  additionalAccessPermissions?: string[];
  /** Every permission string this module declares; feeds the RBAC editor. */
  permissions: string[];
  status: ModuleStatus;
  nav: ModuleNavItem[];
  /**
   * Personal, single-user surfaces (My Info) render in the account menu instead
   * of the module row: they are not team modules, and the row is width-limited.
   * They remain full modules everywhere else, including the hub tile grid.
   */
  personal?: boolean;
};
