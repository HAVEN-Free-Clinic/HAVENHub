import { redirect } from "next/navigation";
import { auth, signIn } from "@/platform/auth/auth";
import { config } from "@/platform/config";

export default async function LoginPage() {
  const session = await auth();
  if (session?.personId) redirect("/hub");

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <h1 className="text-2xl font-semibold">HAVENHub</h1>
        <p className="mt-1 text-sm text-slate-500">
          HAVEN Free Clinic — directors &amp; volunteers
        </p>

        {config.AZURE_AD_CLIENT_ID ? (
          <form
            className="mt-6"
            action={async () => {
              "use server";
              await signIn("microsoft-entra-id", { redirectTo: "/hub" });
            }}
          >
            <button
              type="submit"
              className="w-full rounded-lg bg-blue-700 px-4 py-2.5 font-medium text-white hover:bg-blue-800"
            >
              Sign in with Yale
            </button>
          </form>
        ) : (
          <p className="mt-6 text-sm text-amber-600">
            Entra ID is not configured (AZURE_AD_* unset).
          </p>
        )}

        {config.NODE_ENV !== "production" && (
          <form
            className="mt-4 border-t border-slate-100 pt-4"
            action={async (formData: FormData) => {
              "use server";
              await signIn("credentials", {
                email: formData.get("email"),
                redirectTo: "/hub",
              });
            }}
          >
            <label className="text-xs font-medium text-slate-500" htmlFor="email">
              Dev login (email lookup, local only)
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              placeholder="j.carney@yale.edu"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
            <button
              type="submit"
              className="mt-2 w-full rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-50"
            >
              Dev sign in
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
