import type { ReactNode } from "react";
import { moduleMetadata } from "@/platform/branding/metadata";

export function generateMetadata() {
  return moduleMetadata("my-info");
}

export default function MyInfoLayout({ children }: { children: ReactNode }) {
  return children;
}
