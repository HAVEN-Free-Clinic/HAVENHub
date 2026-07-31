/**
 * Classifies a URL's search params into action-feedback toasts, pure and side-effect free.
 *
 * The app has ~57 pages that render a server-side `<Alert>` from a redirect search param:
 * 121 `?error=` sites, 37 `?saved=` sites, plus a large suffixed-error family (`rosterError`,
 * `rbacError`, `senderError`, ...). This module decides, for a given set of params, which ones
 * are that kind of one-shot flash confirmation (pop a toast, strip the param) and which are
 * everything else the URL might carry -- filters, modes, tokens, redirect targets -- that must
 * be left completely alone. Getting this permissive in the wrong direction silently breaks
 * filtering: five pages validate a `status` param against an enum, and there is no error, no
 * crash, and no failing test if the param quietly stops arriving.
 *
 * Two mechanisms decide a param, in this order:
 *
 * 1. Convention: a param named exactly `error`, or matching `/Error$/`, is an error-tone flash
 *    whose message is its own decoded value. This covers all 121 `error` sites and the whole
 *    suffixed-error family with zero registration. `message` rides along with `error` only, as
 *    `error=validation`'s human-readable detail payload (see admin/notifications/page.tsx:94-99);
 *    it is never claimed on its own and never pairs with a suffixed `*Error` param.
 * 2. Registry: an explicit table for everything the convention cannot express -- a flag param
 *    whose text the page hardcodes (`saved` -> "Saved."), or a group of params a page composes
 *    into one sentence (`sent` + `skipped` -> one release summary). A registry entry only fires
 *    when every param it owns is present, which matters: `sent` alone means something completely
 *    different on admin/email/campaigns/[id]/page.tsx ("Campaign sent to N recipients") than it
 *    does paired with `skipped` on recruitment/cycles/[id]/decisions/page.tsx.
 *
 * Anything not matched by the convention and not in the registry is left untouched: not claimed,
 * not stripped, not turned into a toast.
 */

/** Mirrors the tone vocabulary already established by `src/platform/ui/alert.tsx`. */
export type ToastTone = "error" | "success" | "warning" | "info";

export type FlashToast = {
  tone: ToastTone;
  message: string;
};

export type FlashClassification = {
  /** One toast per claimed param or param group, in the order they were resolved. */
  toasts: FlashToast[];
  /** The exact param names to strip from the URL. Every other param is untouched. */
  stripParams: string[];
};

const ERROR_PARAM = "error";
const MESSAGE_PARAM = "message";
const ERROR_SUFFIX = /Error$/;

function isErrorConventionParam(name: string): boolean {
  return name === ERROR_PARAM || ERROR_SUFFIX.test(name);
}

type FlashRegistryEntry = {
  /** All of these params must be present for the entry to fire; all are stripped together. */
  params: readonly string[];
  tone: ToastTone;
  /** Builds the toast text from the raw (still-encoded-by-nothing, already-decoded) values. */
  message: (values: ReadonlyMap<string, string>) => string;
};

/**
 * Explicit entries for flash shapes the `error`/`*Error` convention cannot express: a flag
 * param whose text the page hardcodes, or a group of params a page composes into one sentence.
 *
 * Every entry here has been confirmed against its actual read site. Do not add an entry for a
 * param you have not opened and confirmed -- the candidate param list was built by pattern
 * matching and over-matches (e.g. `count` in incidents/page.tsx is a word in a code comment).
 */
const FLASH_REGISTRY: readonly FlashRegistryEntry[] = [
  {
    // Seen across ~15 pages, e.g. admin/settings/page.tsx:68,140.
    params: ["saved"],
    tone: "success",
    message: () => "Saved.",
  },
  {
    // recruitment/cycles/[id]/decisions/page.tsx:36-40 and actions.ts:28.
    params: ["sent", "skipped"],
    tone: "success",
    message: (values) =>
      `Released ${values.get("sent")} acceptance email(s); skipped ${values.get("skipped")} conflicted applicant(s).`,
  },
];

/**
 * Classifies the params on a URL into the toasts they should pop and the param names to strip.
 *
 * Pure: takes the params, returns data, touches nothing. Callers (a client-side reader
 * component) are responsible for reading `URLSearchParams` off the current URL, popping the
 * returned toasts, and stripping the returned param names with `router.replace` so a refresh
 * does not re-fire them.
 *
 * `URLSearchParams` is also satisfied by Next.js's `ReadonlyURLSearchParams` (it extends the
 * platform type), so `useSearchParams()` can be passed straight through.
 */
export function classifyFlashParams(params: URLSearchParams): FlashClassification {
  const toasts: FlashToast[] = [];
  const stripParams: string[] = [];
  const claimed = new Set<string>();
  const names = new Set(params.keys());

  // 1. Convention: `error` and the `*Error` suffix family.
  for (const name of names) {
    if (claimed.has(name) || !isErrorConventionParam(name)) continue;

    const ownValue = params.get(name) ?? "";
    const detail = name === ERROR_PARAM ? params.get(MESSAGE_PARAM) : null;

    toasts.push({ tone: "error", message: detail ?? ownValue });
    stripParams.push(name);
    claimed.add(name);

    if (name === ERROR_PARAM && detail !== null) {
      stripParams.push(MESSAGE_PARAM);
      claimed.add(MESSAGE_PARAM);
    }
  }

  // 2. Registry: explicit param groups for shapes the convention can't express.
  for (const entry of FLASH_REGISTRY) {
    if (entry.params.some((p) => claimed.has(p))) continue;
    if (!entry.params.every((p) => params.has(p))) continue;

    const values = new Map(entry.params.map((p) => [p, params.get(p) ?? ""]));
    toasts.push({ tone: entry.tone, message: entry.message(values) });
    for (const p of entry.params) {
      stripParams.push(p);
      claimed.add(p);
    }
  }

  return { toasts, stripParams };
}
