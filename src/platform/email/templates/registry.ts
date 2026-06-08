import type { TemplateDescriptor } from "./types";
import { layoutDescriptor } from "./layout";

export const LAYOUT_KEY = "layout";

// Extended by later tasks (compliance, epic, recruitment descriptors).
const ALL: TemplateDescriptor[] = [layoutDescriptor];

const BY_KEY = new Map(ALL.map((d) => [d.key, d]));

export function getDescriptor(key: string): TemplateDescriptor | undefined {
  return BY_KEY.get(key);
}

export function listDescriptors(): TemplateDescriptor[] {
  return ALL;
}
