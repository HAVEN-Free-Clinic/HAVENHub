import type { TemplateDescriptor } from "./types";
import { layoutDescriptor } from "./layout";
import { complianceDescriptors } from "./compliance";
import { epicDescriptors } from "./epic";
import { recruitmentDescriptors } from "./recruitment";
import { shiftDescriptors } from "./shift";

export const LAYOUT_KEY = "layout";

const ALL: TemplateDescriptor[] = [layoutDescriptor, ...complianceDescriptors, ...epicDescriptors, ...recruitmentDescriptors, ...shiftDescriptors];

const BY_KEY = new Map(ALL.map((d) => [d.key, d]));

export function getDescriptor(key: string): TemplateDescriptor | undefined {
  return BY_KEY.get(key);
}

export function listDescriptors(): TemplateDescriptor[] {
  return ALL;
}
