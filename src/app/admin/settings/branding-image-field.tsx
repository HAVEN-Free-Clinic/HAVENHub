import { buttonClasses } from "@/platform/ui/button";
import type { ResolvedSetting } from "@/platform/settings/service";

/**
 * Upload widget for an `image` setting: current preview + file picker + (when a
 * custom asset is set) a "Use default" button. The two server actions are passed
 * from the settings page so they keep its permission gate.
 */
export function BrandingImageField({
  setting,
  uploadAction,
  removeAction,
}: {
  setting: ResolvedSetting;
  uploadAction: (formData: FormData) => Promise<void>;
  removeAction: (formData: FormData) => Promise<void>;
}) {
  const asset = setting.key.replace("branding.", "");
  const value = setting.value as { contentType: string; version: number };
  const hasCustom = value.contentType !== "";

  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium">{setting.label}</label>
      <p className="text-xs text-gray-500">{setting.help}</p>
      {/* eslint-disable-next-line @next/next/no-img-element -- dynamic same-origin asset route, not a static import */}
      <img
        src={`/api/branding/${asset}?v=${value.version}`}
        alt={`${setting.label} preview`}
        className="h-12 max-w-[200px] rounded border bg-slate-100 object-contain p-1"
      />
      <form action={uploadAction} encType="multipart/form-data" className="flex items-center gap-2">
        <input type="hidden" name="__asset" value={asset} />
        <input
          type="file"
          name="file"
          accept="image/png,image/jpeg,image/webp,image/x-icon"
          className="text-sm"
        />
        <button type="submit" className={buttonClasses("primary", "sm")}>
          Upload
        </button>
      </form>
      {hasCustom && (
        <form action={removeAction}>
          <input type="hidden" name="__asset" value={asset} />
          <button type="submit" className={buttonClasses("outline", "sm")}>
            Use default
          </button>
        </form>
      )}
    </div>
  );
}
