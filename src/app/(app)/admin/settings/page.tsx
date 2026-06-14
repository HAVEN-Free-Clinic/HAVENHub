import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import { PageHeader } from "@/platform/ui/page-header";
import { buttonClasses } from "@/platform/ui/button";
import { Card } from "@/platform/ui/card";
import { Checkbox } from "@/platform/ui/checkbox";
import { Alert } from "@/platform/ui/alert";
import { Select } from "@/platform/ui/select";
import { Input, Textarea } from "@/platform/ui/input";
import { listCategories } from "@/platform/settings/registry";
import {
  getCategory,
  setSetting,
  resetSetting,
  SettingValidationError,
  type ResolvedSetting,
} from "@/platform/settings/service";
import { BRANDING_ASSETS, type BrandingAssetName } from "@/platform/branding/asset-types";
import { saveBrandingAsset, removeBrandingAsset, BrandingAssetError } from "@/platform/branding/assets";
import { BrandingImageField } from "./branding-image-field";

const PERMISSION = "admin.manage_settings";

/** Coerce a submitted form string to the value the setting's schema expects. */
function coerce(input: ResolvedSetting["input"], raw: FormDataEntryValue | null): unknown {
  switch (input.type) {
    case "number":
      return raw === null || raw === "" ? NaN : Number(raw);
    case "boolean":
      return raw === "on" || raw === "true";
    default:
      return typeof raw === "string" ? raw : "";
  }
}

type PageProps = { searchParams: Promise<{ error?: string; saved?: string }> };

export default async function SettingsPage({ searchParams }: PageProps) {
  await requirePermission(PERMISSION);
  const { error, saved } = await searchParams;

  async function updateAction(formData: FormData) {
    "use server";
    const session = await requirePermission(PERMISSION);
    const key = String(formData.get("__key"));
    const groups = await Promise.all(listCategories().map((c) => getCategory(c)));
    const def = groups.flat().find((s) => s.key === key);
    if (!def) redirect(`/admin/settings?error=${encodeURIComponent("Unknown setting")}`);

    const value = coerce(def.input, formData.get(key));
    try {
      await setSetting(key, value, session.personId);
    } catch (err) {
      if (err instanceof SettingValidationError) {
        redirect(`/admin/settings?error=${encodeURIComponent(`${def.label}: ${err.message}`)}`);
      }
      throw err;
    }
    revalidatePath("/admin/settings");
    redirect("/admin/settings?saved=1");
  }

  async function resetAction(formData: FormData) {
    "use server";
    const session = await requirePermission(PERMISSION);
    const key = String(formData.get("__key"));
    // Defensive: resetSetting throws (500) for an unregistered key. The key
    // comes from a server-rendered hidden input so this is unreachable in
    // practice, but guard it to match updateAction and fail gracefully.
    const known = (await Promise.all(listCategories().map((c) => getCategory(c))))
      .flat()
      .some((s) => s.key === key);
    if (!known) redirect(`/admin/settings?error=${encodeURIComponent("Unknown setting")}`);
    await resetSetting(key, session.personId);
    revalidatePath("/admin/settings");
    redirect("/admin/settings?saved=1");
  }

  async function uploadBrandingAction(formData: FormData) {
    "use server";
    const session = await requirePermission(PERMISSION);
    const asset = String(formData.get("__asset"));
    if (!BRANDING_ASSETS.includes(asset as BrandingAssetName)) {
      redirect(`/admin/settings?error=${encodeURIComponent("Unknown asset")}`);
    }
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) {
      redirect(`/admin/settings?error=${encodeURIComponent("Choose an image file to upload")}`);
    }
    const bytes = Buffer.from(await file.arrayBuffer());
    try {
      await saveBrandingAsset(
        asset as BrandingAssetName,
        { name: file.name, type: file.type, size: file.size, bytes },
        session.personId
      );
    } catch (err) {
      if (err instanceof BrandingAssetError) {
        redirect(`/admin/settings?error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    revalidatePath("/admin/settings");
    redirect("/admin/settings?saved=1");
  }

  async function removeBrandingAction(formData: FormData) {
    "use server";
    const session = await requirePermission(PERMISSION);
    const asset = String(formData.get("__asset"));
    if (!BRANDING_ASSETS.includes(asset as BrandingAssetName)) {
      redirect(`/admin/settings?error=${encodeURIComponent("Unknown asset")}`);
    }
    await removeBrandingAsset(asset as BrandingAssetName, session.personId);
    revalidatePath("/admin/settings");
    redirect("/admin/settings?saved=1");
  }

  const categories = listCategories();
  const groups = await Promise.all(
    categories.map(async (category) => ({ category, settings: await getCategory(category) }))
  );

  return (
    <div className="space-y-8">
      <PageHeader
        title="Settings"
        description="Configure app behavior without redeploying. Changes are audited."
      />

      {error && <Alert tone="error">{error}</Alert>}
      {saved && !error && <Alert tone="success">Saved.</Alert>}

      {groups.map(({ category, settings }) => (
        <section key={category} className="space-y-4">
          <h2 className="text-lg font-semibold">{category}</h2>
          <div className="space-y-6">
            {settings.map((s) => (
              <Card key={s.key} pad={false} className="p-4">
                {s.input.type === "image" ? (
                  <BrandingImageField
                    setting={s}
                    uploadAction={uploadBrandingAction}
                    removeAction={removeBrandingAction}
                  />
                ) : (
                  <>
                    <form action={updateAction} className="space-y-2">
                      <input type="hidden" name="__key" value={s.key} />
                      <label htmlFor={s.key} className="block text-sm font-medium">
                        {s.label}
                      </label>
                      <p className="text-xs text-muted-foreground">{s.help}</p>
                      {s.input.type === "boolean" ? (
                        <Checkbox
                          id={s.key}
                          name={s.key}
                          defaultChecked={Boolean(s.value)}
                        />
                      ) : s.input.type === "select" ? (
                        <Select id={s.key} name={s.key} defaultValue={String(s.value)}>
                          {s.input.options.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </Select>
                      ) : s.input.type === "textarea" ? (
                        <Textarea id={s.key} name={s.key} defaultValue={String(s.value)} />
                      ) : s.input.type === "color" ? (
                        <Input
                          id={s.key}
                          name={s.key}
                          type="color"
                          defaultValue={String(s.value)}
                          className="h-9 w-16 p-1"
                        />
                      ) : (
                        <Input
                          id={s.key}
                          name={s.key}
                          type={s.input.type === "number" ? "number" : "text"}
                          defaultValue={String(s.value)}
                          min={s.input.type === "number" ? s.input.min : undefined}
                          max={s.input.type === "number" ? s.input.max : undefined}
                        />
                      )}
                      <div className="flex items-center gap-2 pt-1">
                        <button type="submit" className={buttonClasses("primary", "sm")}>
                          Save
                        </button>
                        {s.isOverridden && (
                          <span className="text-xs text-warning">Currently overriding the default</span>
                        )}
                      </div>
                    </form>
                    {s.isOverridden && (
                      <form action={resetAction} className="pt-2">
                        <input type="hidden" name="__key" value={s.key} />
                        <button type="submit" className={buttonClasses("outline", "sm")}>
                          Reset to default
                        </button>
                      </form>
                    )}
                  </>
                )}
              </Card>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
