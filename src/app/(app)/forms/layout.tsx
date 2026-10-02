import type { ReactNode } from "react";
import { requireModuleAccess } from "@/platform/auth/session";
import { moduleMetadata } from "@/platform/branding/metadata";

export function generateMetadata() {
  return moduleMetadata("forms");
}

export default async function FormsLayout({ children }: { children: ReactNode }) {
  await requireModuleAccess("forms");
  return children;
}
