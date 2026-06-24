// src/platform/notifications/channel.ts
import { getSetting } from "@/platform/settings/service";
import { channelSettingKey, type NotificationChannel } from "./registry";

/** Resolve a notification type's delivery channel (DB override -> default "email"). */
export async function resolveChannel(typeKey: string): Promise<NotificationChannel> {
  return getSetting<NotificationChannel>(channelSettingKey(typeKey));
}
