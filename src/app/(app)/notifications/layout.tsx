import type { ReactNode } from "react";
import { buildPageMetadata } from "@/platform/branding/metadata";

export function generateMetadata() {
  return buildPageMetadata({ title: "Notifications", description: "Your notification inbox" });
}

export default function NotificationsLayout({ children }: { children: ReactNode }) {
  return children;
}
