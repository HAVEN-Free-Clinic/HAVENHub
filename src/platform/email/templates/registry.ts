import type { TemplateDescriptor } from "./types";
import { layoutDescriptor } from "./layout";
import { complianceDescriptors } from "./compliance";
import { clearanceDescriptors } from "./clearance";
import { attendanceDescriptors } from "./attendance";
import { epicDescriptors } from "./epic";
import { recruitmentDescriptors } from "./recruitment";
import { supportDescriptors } from "./support";
import { shiftDescriptors } from "./shift";
import { attendingDescriptors } from "./attending";
import { scheduleDescriptors } from "./schedule";
import { incidentsDescriptors } from "./incidents";
import { authDescriptors } from "./auth";
import { volunteersDescriptors } from "./volunteers";

export const LAYOUT_KEY = "layout";

const ALL: TemplateDescriptor[] = [
  layoutDescriptor,
  ...complianceDescriptors,
  ...clearanceDescriptors,
  ...attendanceDescriptors,
  ...epicDescriptors,
  ...recruitmentDescriptors,
  ...supportDescriptors,
  ...shiftDescriptors,
  ...attendingDescriptors,
  ...scheduleDescriptors,
  ...incidentsDescriptors,
  ...authDescriptors,
  ...volunteersDescriptors,
];

const BY_KEY = new Map(ALL.map((d) => [d.key, d]));

export function getDescriptor(key: string): TemplateDescriptor | undefined {
  return BY_KEY.get(key);
}

export function listDescriptors(): TemplateDescriptor[] {
  return ALL;
}
