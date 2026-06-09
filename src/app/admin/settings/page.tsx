import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import { PageHeader } from "@/platform/ui/page-header";
import { buttonClasses } from "@/platform/ui/button";
import { listCategories } from "@/platform/settings/registry";
import {
  getCategory,
  setSetting,
  resetSetting,
  SettingValidationError,
  type ResolvedSetting,
} from "@/platform/settings/service";

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
    await resetSetting(key, session.personId);
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

      {error && (
        <p className="rounded-md bg-red-50 px-4 py-2 text-sm text-red-700">{error}</p>
      )}
      {saved && !error && (
        <p className="rounded-md bg-green-50 px-4 py-2 text-sm text-green-700">Saved.</p>
      )}

      {groups.map(({ category, settings }) => (
        <section key={category} className="space-y-4">
          <h2 className="text-lg font-semibold">{category}</h2>
          <div className="space-y-6">
            {settings.map((s) => (
              <div key={s.key} className="rounded-lg border border-gray-200 p-4">
                <form action={updateAction} className="space-y-2">
                  <input type="hidden" name="__key" value={s.key} />
                  <label htmlFor={s.key} className="block text-sm font-medium">
                    {s.label}
                  </label>
                  <p className="text-xs text-gray-500">{s.help}</p>
                  {s.input.type === "boolean" ? (
                    <input
                      id={s.key}
                      name={s.key}
                      type="checkbox"
                      defaultChecked={Boolean(s.value)}
                    />
                  ) : s.input.type === "select" ? (
                    <select id={s.key} name={s.key} defaultValue={String(s.value)} className="border rounded px-2 py-1">
                      {s.input.options.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  ) : s.input.type === "textarea" ? (
                    <textarea id={s.key} name={s.key} defaultValue={String(s.value)} className="border rounded px-2 py-1 w-full" />
                  ) : (
                    <input
                      id={s.key}
                      name={s.key}
                      type={s.input.type === "number" ? "number" : "text"}
                      defaultValue={String(s.value)}
                      min={s.input.type === "number" ? s.input.min : undefined}
                      max={s.input.type === "number" ? s.input.max : undefined}
                      className="border rounded px-2 py-1"
                    />
                  )}
                  <div className="flex items-center gap-2 pt-1">
                    <button type="submit" className={buttonClasses("primary", "sm")}>
                      Save
                    </button>
                    {s.isOverridden && (
                      <span className="text-xs text-amber-600">Overridden (default: not in use)</span>
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
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
