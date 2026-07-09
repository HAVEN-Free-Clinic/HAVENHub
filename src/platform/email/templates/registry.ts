import type { TemplateDescriptor } from "./types";
import { layoutDescriptor } from "./layout";
import { complianceDescriptors } from "./compliance";
import { epicDescriptors } from "./epic";
import { recruitmentDescriptors } from "./recruitment";
import { supportDescriptors } from "./support";
import { shiftDescriptors } from "./shift";
import { scheduleDescriptors } from "./schedule";

export const LAYOUT_KEY = "layout";

const ALL: TemplateDescriptor[] = [
  layoutDescriptor,
  ...complianceDescriptors,
  ...epicDescriptors,
  ...recruitmentDescriptors,
  ...supportDescriptors,
  ...shiftDescriptors,
  ...scheduleDescriptors,
];

const BY_KEY = new Map(ALL.map((d) => [d.key, d]));

export function getDescriptor(key: string): TemplateDescriptor | undefined {
  return BY_KEY.get(key);
}

export function listDescriptors(): TemplateDescriptor[] {
  return ALL;
}
