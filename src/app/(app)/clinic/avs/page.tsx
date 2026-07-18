import { getSetting } from "@/platform/settings/service";
import { AvsTool } from "@/modules/clinic/avs/avs-tool";

export default async function AvsPage() {
  const [brandColor, orgName, supportEmail] = await Promise.all([
    getSetting<string>("branding.brandColor"),
    getSetting<string>("branding.orgName"),
    getSetting<string>("branding.supportEmail"),
  ]);
  // Identify the issuing clinic on the patient handout (the disclaimer tells them
  // to "contact the clinic"), and give a real contact when one is configured.
  return <AvsTool brandColor={brandColor} orgName={orgName} supportContact={supportEmail || undefined} />;
}
