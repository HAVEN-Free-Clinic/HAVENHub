import { getSetting } from "@/platform/settings/service";
import { AvsTool } from "@/modules/clinic/avs/avs-tool";

export default async function AvsPage() {
  const brandColor = await getSetting<string>("branding.brandColor");
  return <AvsTool brandColor={brandColor} />;
}
