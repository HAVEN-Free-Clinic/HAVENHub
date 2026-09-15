import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import { PageHeader } from "@/platform/ui/page-header";
import { Button } from "@/platform/ui/button";
import { Card } from "@/platform/ui/card";
import { Checkbox } from "@/platform/ui/checkbox";
import { Select } from "@/platform/ui/select";
import { Input, Textarea, Field } from "@/platform/ui/input";
import { ROW_WIDTH } from "@/platform/ui/form";
import { cx } from "@/platform/ui/cx";
import { SectionHeader } from "@/platform/ui/section-header";
import { listCategories } from "@/platform/settings/registry";
import {
  getCategory,
  setSettings,
  resetSetting,
  SettingValidationError,
  type ResolvedSetting,
} from "@/platform/settings/service";
import { emailRoutingGap } from "@/platform/email/routing-gap";
import { RoutingGapAlert } from "../routing-gap-alert";
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

export default async function SettingsPage() {
  await requirePermission(PERMISSION);

  /**
   * One Save per category. The page used to carry a form and a Save button on
   * every setting (about 66 of them, on a page 13,800px tall), so changing three
   * related values meant three saves and three reloads.
   *
   * Only fields that moved are written: re-saving an untouched one would store
   * an override equal to what it already was and audit a non-event. And the
   * whole category is checked before any of it is written (setSettings), so one
   * bad field does not leave the ones before it applied.
   */
  async function saveCategoryAction(formData: FormData) {
    "use server";
    const session = await requirePermission(PERMISSION);
    const category = String(formData.get("__category"));
    if (!listCategories().includes(category)) {
      redirect(`/admin/settings?error=${encodeURIComponent("Unknown settings group")}`);
    }
    const settings = await getCategory(category);

    const changes: { key: string; value: unknown }[] = [];
    for (const s of settings) {
      // Images save through their own upload forms, outside this one.
      if (s.input.type === "image") continue;
      const value = coerce(s.input, formData.get(s.key));
      // A blank numeric field coerces to NaN, which Zod rejects with the raw
      // "Expected number, received nan"; surface a human message instead.
      if (s.input.type === "number" && Number.isNaN(value)) {
        redirect(`/admin/settings?error=${encodeURIComponent(`${s.label}: enter a whole number.`)}`);
      }
      if (!sameValue(s.input, value, s.value)) changes.push({ key: s.key, value });
    }
    if (changes.length === 0) redirect("/admin/settings");

    try {
      await setSettings(changes, session.personId);
    } catch (err) {
      if (err instanceof SettingValidationError) {
        const label = settings.find((s) => s.key === err.key)?.label ?? err.key;
        redirect(`/admin/settings?error=${encodeURIComponent(`${label}: ${err.message}`)}`);
      }
      throw err;
    }
    revalidatePath("/admin/settings");
    redirect("/admin/settings?saved=1");
  }

  // Bound to its key per field (resetAction.bind(null, key)) rather than reading
  // one from the form: Reset is a button on the category's shared form, and a
  // bound argument does not depend on the clicked button's name/value riding
  // along in the submission.
  async function resetAction(key: string) {
    "use server";
    const session = await requirePermission(PERMISSION);
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

  // THE ONE SETTING ON THIS PAGE WITH AN INVISIBLE CONSEQUENCE. Flipping
  // email.transport to "maileroo" moves every configured send-from address that
  // Graph does not carry onto Maileroo, silently -- see routing-gap.ts. This is
  // the screen that flip happens on, so this is where the list has to appear.
  //
  // Rendered inline against a known key rather than through a new generic
  // "notice" hook on SettingDef. The registry stays a declaration of settings,
  // one special case is cheaper to read than a mechanism serving one caller, and
  // this page already special-cases the branding image inputs the same way. It
  // degrades to null on a database problem, which is what keeps the settings
  // form rendering during an outage as getCategory already does.
  const routingGap = await emailRoutingGap();

  return (
    <div className="space-y-8">
      <PageHeader
        title="Settings"
        description="Configure app behavior without redeploying. Changes are audited."
      />

      {groups.map(({ category, settings }) => {
        const fields = settings.filter((s) => s.input.type !== "image");
        const images = settings.filter((s) => s.input.type === "image");
        return (
          <section key={category} className="space-y-4">
            {fields.length === 0 && <SectionHeader level="title">{category}</SectionHeader>}
            {fields.length > 0 && (
              <Card>
                <form action={saveCategoryAction}>
                  <input type="hidden" name="__category" value={category} />
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle pb-3">
                    <SectionHeader level="title">{category}</SectionHeader>
                    {/* The FIRST submit button in this form, on purpose. Enter in
                        any field submits with the form's first submit button, and
                        the per-field Reset buttons below are submit buttons too;
                        with Save after them, Enter would reset a setting.
                        Outline, not primary: one per category, several on the
                        page, so a brand fill would stop meaning "the thing to do
                        here" (FilterBar's rule for a repeated control). */}
                    <Button type="submit" variant="outline" size="sm">Save</Button>
                  </div>
                  <div className="grid gap-x-8 gap-y-6 pt-4 md:grid-cols-2">
                    {fields.map((s) => (
                      <div
                        key={s.key}
                        className={cx("space-y-2", (s.input.type === "textarea" || s.key === "email.transport") && "md:col-span-2")}
                      >
                        {s.key === "email.transport" && (
                          <RoutingGapAlert gap={routingGap} where="settings" />
                        )}
                        <Field label={s.label} hint={s.help}>
                          {s.input.type === "boolean" ? (
                            <Checkbox
                              name={s.key}
                              defaultChecked={Boolean(s.value)}
                            />
                          ) : s.input.type === "select" ? (
                            <Select name={s.key} defaultValue={String(s.value)}>
                              {s.input.options.map((o) => (
                                <option key={o.value} value={o.value}>
                                  {o.label}
                                </option>
                              ))}
                            </Select>
                          ) : s.input.type === "textarea" ? (
                            <Textarea name={s.key} defaultValue={String(s.value)} />
                          ) : s.input.type === "color" ? (
                            <Input
                              name={s.key}
                              type="color"
                              defaultValue={String(s.value)}
                              className="h-9 w-16 p-1"
                            />
                          ) : s.input.type === "number" ? (
                            // A one- or two-digit number in a full-width box read
                            // as a text field. The width is a wrapper, not a class
                            // on Input, which is w-full and has no tailwind-merge
                            // to arbitrate a second width.
                            <div className={ROW_WIDTH.numeric}>
                              <Input
                                name={s.key}
                                type="number"
                                defaultValue={String(s.value)}
                                min={s.input.min}
                                max={s.input.max}
                              />
                            </div>
                          ) : (
                            <Input name={s.key} type="text" defaultValue={String(s.value)} />
                          )}
                        </Field>
                        {s.isOverridden && (
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs text-muted-foreground">Overriding the default</span>
                            {/* Ghost, so Save stays the louder of the two. Its own
                                action on the shared form; formNoValidate so an
                                invalid value elsewhere cannot block a reset. */}
                            <Button
                              type="submit"
                              variant="ghost"
                              size="sm"
                              formAction={resetAction.bind(null, s.key)}
                              formNoValidate
                            >
                              Reset to default
                            </Button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </form>
              </Card>
            )}
            {images.map((s) => (
              <Card key={s.key} pad={false} className="p-4">
                <BrandingImageField
                  setting={s}
                  uploadAction={uploadBrandingAction}
                  removeAction={removeBrandingAction}
                />
              </Card>
            ))}
          </section>
        );
      })}
    </div>
  );
}

/**
 * Whether a submitted value is the one the field rendered with. Loose where the
 * browser rewrites an untouched field: a textarea submits its newlines as CRLF,
 * and a colour input submits lowercase hex. Either would otherwise read as an
 * edit on every save of the category.
 */
function sameValue(input: ResolvedSetting["input"], submitted: unknown, current: unknown): boolean {
  const norm = (v: unknown) =>
    typeof v !== "string" ? v : input.type === "color" ? v.toLowerCase() : v.replace(/\r\n/g, "\n");
  return JSON.stringify(norm(submitted)) === JSON.stringify(norm(current));
}
