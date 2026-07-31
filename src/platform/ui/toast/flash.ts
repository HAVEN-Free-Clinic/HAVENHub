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
 * 1. Convention: a param named exactly `error`, or matching `/Error$/`, is an error-tone flash.
 *    This covers all 121 `error` sites and the whole suffixed-error family with zero
 *    registration. `message` rides along with `error` only, as `error=validation`'s
 *    human-readable detail payload (see admin/notifications/page.tsx:94-99); it is never claimed
 *    on its own and never pairs with a suffixed `*Error` param.
 *
 *    The bare `error` param has two shapes in this codebase (spec amendment, 2026-07-30): ~85
 *    sites encode the human-readable message directly (`?error=${encodeURIComponent(err.message)}`)
 *    and ~36 sites send a short code (`error=validation`, `error=forbidden`, ...) that the page
 *    resolves through its own `ERROR_MESSAGES` lookup. When `message` is absent, this module
 *    checks the value against a small shared code table (below); a recognised code resolves to
 *    its text, and anything else is treated as the message itself -- which is exactly correct for
 *    the 85 raw-text sites and is the deliberate reading of "if a value is not a known code, it
 *    IS the message." Only genuinely page-owned vocabulary (`login/page.tsx`'s NextAuth codes,
 *    `incidents/page.tsx`'s `subject-not-found`, `incidents/strikes/page.tsx`'s `bad-category` /
 *    `blank-description` / `future-date` / `person-not-found` / its own `not-found` text) is
 *    deliberately excluded from the shared table; those pages are ruled INLINE and keep their own
 *    rendering.
 * 2. Registry: an explicit table for everything the convention cannot express -- a flag param
 *    whose text the page hardcodes (`saved` -> "Saved."), or a group of params a page composes
 *    into one sentence (`sent` + `skipped` -> one release summary). A registry entry only fires
 *    when every param it owns is present, which matters: `sent` alone means something completely
 *    different on admin/email/campaigns/[id]/page.tsx ("Campaign sent to N recipients") than it
 *    does paired with `skipped` on recruitment/cycles/[id]/decisions/page.tsx.
 *
 * Anything not matched by the convention and not in the registry is left untouched: not claimed,
 * not stripped, not turned into a toast.
 *
 * ---
 *
 * **Pathname scoping (spec amendment, 2026-07-30, after the Task 2 inventory).** A param name
 * does not mean one thing app-wide. `saved` renders at least eight different sentences across the
 * app (the seeded `saved -> "Saved."` entry is right for only about five call sites); `sent` means
 * three different things on three different pages; `?error=not-found` means "The incident report
 * could not be found." on one page and "The disciplinary action could not be found." on another.
 * A registry entry may therefore carry an optional `pathnames` scope: a list of path patterns
 * (`*` matches exactly one path segment, e.g. a dynamic route id) that restricts where the entry
 * applies. Entries sharing the same param set (and, where present, the same `matchValues`) form a
 * group; within a group, a scoped entry wins on a matching pathname, and the group's one unscoped
 * entry (if any) is the default everywhere else. A group with no unscoped entry and no matching
 * scoped entry simply does not fire -- there is nothing to fall back to, which is correct: a param
 * this page-specific should never guess.
 *
 * `not-found` is a confirmed real conflict between `incidents/[id]/page.tsx` ("The incident report
 * could not be found.") and `incidents/strikes/page.tsx` ("The disciplinary action could not be
 * found.") but is deliberately NOT in the shared code table below. `incidents/strikes/page.tsx` is
 * ruled INLINE as a whole page (it owns other, genuinely page-specific codes), so only
 * `incidents/[id]/page.tsx` would ever contribute `not-found` to the shared table. Scoping it
 * there needs a pathname pattern that matches `/incidents/[id]` but not the sibling static routes
 * `/incidents/mine`, `/incidents/review`, and `/incidents/strikes`, which the segment-wildcard
 * matcher below cannot express (a `*` in that position matches all four equally). Left for
 * whoever migrates `incidents/[id]/page.tsx` in a later task, once the matcher can be extended or
 * a narrower pattern is confirmed against the live route.
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

/**
 * The bare `error` param's shared code vocabulary: codes whose text is identical everywhere they
 * are confirmed to appear. Confirmed against `incidents/[id]/page.tsx`, `admin/notifications/page.tsx`,
 * `admin/email/page.tsx`, `schedule/page.tsx`, and `schedule/builder/page.tsx`.
 *
 * Deliberately excluded: `not-found` (see the module doc comment -- a real conflict, not yet
 * scopable), and every page-owned code (`subject-not-found`, `bad-category`, `blank-description`,
 * `future-date`, `person-not-found`, NextAuth's `CredentialsSignin` / `MemberLinkExpired`). Do not
 * add `lastError` here or anywhere in this module: it is a `TeamsMessage` / `EmailLog` database
 * column (`row.lastError`), never a URL param. It reached the design spec's own suffixed-error
 * list by mistake; the `/Error$/` convention would still (harmlessly, since nothing ever sets it
 * on a URL) claim it as raw text if it ever showed up there, exactly like the other 85 sites.
 *
 * `validation`'s text is copied from the three incidents pages' `ERROR_MESSAGES["validation"]`
 * rather than `admin/notifications` / `admin/email`'s generic "An unexpected error occurred.".
 * This is a real, if practically unreachable, difference: every live redirect to `error=validation`
 * also sets `message` (confirmed by grep), so this table is only ever consulted for `validation`
 * on the one page that reaches it message-less (`incidents/strikes/page.tsx:223`, which is
 * INLINE-ruled but happens to carry byte-identical text to this entry regardless).
 */
const ERROR_CODE_TABLE: Readonly<Record<string, string>> = {
  forbidden: "You do not have permission for that action.",
  validation: "Please check your input and try again.",
};

function resolveErrorValue(rawValue: string): string {
  return ERROR_CODE_TABLE[rawValue] ?? rawValue;
}

type FlashRegistryEntry = {
  /** All of these params must be present for the entry to fire; all are stripped together. */
  params: readonly string[];
  /**
   * Optional literal-value requirement per param. When a param name appears here, the entry only
   * fires when that param's value equals this exact string, not merely when it is present. Used
   * for a bare flag param (like `message`) that carries more than one distinct meaning by value.
   */
  matchValues?: Readonly<Record<string, string>>;
  tone: ToastTone | ((values: ReadonlyMap<string, string>) => ToastTone);
  /** Builds the toast text from the raw (still-encoded-by-nothing, already-decoded) values. */
  message: (values: ReadonlyMap<string, string>) => string;
  /**
   * Optional pathname scope: a list of path patterns (`*` matches exactly one path segment) this
   * entry applies to. Omitted means unscoped -- the default for its param group, used wherever no
   * scoped sibling in the same group matches. See the module doc comment for the full resolution
   * rule.
   */
  pathnames?: readonly string[];
};

/**
 * Explicit entries for flash shapes the `error`/`*Error` convention cannot express: a flag
 * param whose text the page hardcodes, or a group of params a page composes into one sentence.
 *
 * Every entry here has been confirmed against its actual read site. Do not add an entry for a
 * param you have not opened and confirmed -- the candidate param list was built by pattern
 * matching and over-matches (e.g. `count` in incidents/page.tsx is a word in a code comment).
 *
 * **Order matters for params that appear in more than one group.** Groups are resolved in the
 * order their first entry appears here, and once a param is claimed by an earlier group it cannot
 * be claimed again. `sent` appears in three groups (`sent`+`skipped` on the decisions page,
 * `promoted`+`sent` on the waitlist page, and a lone `sent` on the campaigns page); the two-param
 * groups are declared first so a URL carrying `sent` alongside `skipped` or `promoted` is always
 * claimed by the right group. The lone `sent` entry is also pathname-scoped to the campaigns page
 * as a second, independent guard against ever mis-firing on the other two pages.
 */
const FLASH_REGISTRY: readonly FlashRegistryEntry[] = [
  {
    // Seen across ~15 pages, e.g. admin/settings/page.tsx:68,140. This is the right text for
    // roughly five of them; every page with its own wording gets a scoped sibling entry below,
    // or (per the design spec's carve-out for page-local copy) composes its own text via
    // useToast() directly and never reaches this entry at all.
    params: ["saved"],
    tone: "success",
    message: () => "Saved.",
  },
  {
    // schedule/page.tsx:219-223. "Availability saved successfully.", not the generic "Saved." --
    // the concrete example the design spec's pathname-scoping amendment names by name.
    params: ["saved"],
    pathnames: ["/schedule"],
    tone: "success",
    message: () => "Availability saved successfully.",
  },
  {
    // recruitment/cycles/[id]/decisions/page.tsx:36-40 and actions.ts:28.
    params: ["sent", "skipped"],
    tone: "success",
    message: (values) =>
      `Released ${values.get("sent")} acceptance email(s); skipped ${values.get("skipped")} conflicted applicant(s).`,
  },
  {
    // recruitment/cycles/[id]/waitlist/page.tsx:38-47 and actions.ts. `sent` here is a
    // single-applicant email-outcome flag/reason string ("1", "conflicted", or a reason from
    // sendAcceptanceEmail), never a count -- a completely different shape from the decisions
    // page's `sent`, disambiguated by being paired with `promoted` instead of `skipped`.
    params: ["promoted", "sent"],
    pathnames: ["/recruitment/cycles/*/waitlist"],
    tone: (values) => (values.get("sent") === "conflicted" ? "warning" : "success"),
    message: (values) => {
      const promoted = values.get("promoted") ?? "";
      const sent = values.get("sent") ?? "";
      if (sent === "conflicted") {
        return `Promoted ${promoted} to accepted, but they now hold offers from more than one department. Resolve the conflict on the Decisions page, then release to email them.`;
      }
      return `Promoted ${promoted} to accepted${sent === "1" ? " and emailed them." : "."}`;
    },
  },
  {
    // admin/email/campaigns/[id]/page.tsx:227-228,317-320. A standalone recipient count, never
    // paired with `skipped` or `promoted` -- declared last among the `sent`-owning groups (see
    // the doc comment above) and pathname-scoped as a second guard.
    params: ["sent"],
    pathnames: ["/admin/email/campaigns/*"],
    tone: "success",
    message: (values) => {
      const sent = values.get("sent") ?? "";
      return `Campaign sent to ${sent} ${sent === "1" ? "recipient" : "recipients"}.`;
    },
  },
  {
    // schedule/page.tsx:179-196,229-233. remindDirectorsAction redirects to `/schedule?message=reminded`
    // with NO `error` present at all, so the `error`/`message` convention above never claims it
    // (message only rides along with error). Two literal-value entries on the same bare param.
    params: ["message"],
    matchValues: { message: "reminded" },
    pathnames: ["/schedule"],
    tone: "success",
    message: () => "Reminder sent to your department directors.",
  },
  {
    // schedule/page.tsx:193-195,234-238. The throttled-reminder companion to the entry above.
    params: ["message"],
    matchValues: { message: "already_reminded" },
    pathnames: ["/schedule"],
    tone: "info",
    message: () =>
      "Your department directors were already reminded recently, so no new email was sent.",
  },
  {
    // recruitment/cycles/[id]/onboarding/page.tsx:51 and recruitment/cycles/[id]/training/page.tsx:45.
    // Neither `err` nor `msg` matches the `error`/`message` convention (different literal names).
    // Modeled as two independent single-param entries, not one joint group: onboarding's own
    // action can set both `err` and `msg` in the same redirect and expects two separate
    // simultaneous toasts, not one composed sentence.
    params: ["err"],
    pathnames: ["/recruitment/cycles/*/onboarding", "/recruitment/cycles/*/training"],
    tone: "error",
    message: (values) => values.get("err") ?? "",
  },
  {
    params: ["msg"],
    pathnames: ["/recruitment/cycles/*/onboarding", "/recruitment/cycles/*/training"],
    tone: "success",
    message: (values) => values.get("msg") ?? "",
  },
];

/** `*` matches exactly one path segment (e.g. a dynamic route id); every other segment is literal. */
function matchesPathname(pattern: string, pathname: string): boolean {
  const patternSegments = pattern.split("/");
  const pathSegments = pathname.split("/");
  if (patternSegments.length !== pathSegments.length) return false;
  return patternSegments.every((segment, i) => segment === "*" || segment === pathSegments[i]);
}

function entryMatchesPathname(entry: FlashRegistryEntry, pathname: string): boolean {
  return entry.pathnames !== undefined && entry.pathnames.some((p) => matchesPathname(p, pathname));
}

/** A stable key for the param set + literal-value requirement a set of entries share. */
function groupKey(entry: FlashRegistryEntry): string {
  const params = [...entry.params].sort().join(",");
  const matchValues = entry.matchValues
    ? Object.entries(entry.matchValues)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join(",")
    : "";
  return `${params}|${matchValues}`;
}

/** Groups registry entries by `groupKey`, preserving the order each group first appears. */
function groupRegistry(
  registry: readonly FlashRegistryEntry[],
): readonly (readonly FlashRegistryEntry[])[] {
  const byKey = new Map<string, FlashRegistryEntry[]>();
  const order: string[] = [];
  for (const entry of registry) {
    const key = groupKey(entry);
    const existing = byKey.get(key);
    if (existing) {
      existing.push(entry);
    } else {
      byKey.set(key, [entry]);
      order.push(key);
    }
  }
  return order.map((key) => byKey.get(key)!);
}

const FLASH_REGISTRY_GROUPS = groupRegistry(FLASH_REGISTRY);

/** Within a group, a matching scoped entry wins; otherwise the group's unscoped entry (if any). */
function resolveGroupEntry(
  group: readonly FlashRegistryEntry[],
  pathname: string,
): FlashRegistryEntry | null {
  const scoped = group.find((entry) => entryMatchesPathname(entry, pathname));
  if (scoped) return scoped;
  return group.find((entry) => entry.pathnames === undefined) ?? null;
}

/**
 * Classifies the params on a URL into the toasts they should pop and the param names to strip.
 *
 * Pure: takes the params and the current pathname, returns data, touches nothing. Callers (a
 * client-side reader component) are responsible for reading `URLSearchParams` and the pathname off
 * the current URL, popping the returned toasts, and stripping the returned param names with
 * `router.replace` so a refresh does not re-fire them.
 *
 * `pathname` should be a clean path with no query string and no trailing slash, matching
 * `usePathname()` -- e.g. `/schedule`, `/recruitment/cycles/abc123/waitlist`. It decides which
 * pathname-scoped registry entry (if any) wins for a given param group; see the module doc
 * comment for the full resolution rule.
 *
 * `URLSearchParams` is also satisfied by Next.js's `ReadonlyURLSearchParams` (it extends the
 * platform type), so `useSearchParams()` can be passed straight through.
 */
export function classifyFlashParams(params: URLSearchParams, pathname: string): FlashClassification {
  const toasts: FlashToast[] = [];
  const stripParams: string[] = [];
  const claimed = new Set<string>();
  const names = new Set(params.keys());

  // 1. Convention: `error` and the `*Error` suffix family.
  for (const name of names) {
    if (claimed.has(name) || !isErrorConventionParam(name)) continue;

    const ownValue = params.get(name) ?? "";
    const detail = name === ERROR_PARAM ? params.get(MESSAGE_PARAM) : null;
    const message = detail ?? (name === ERROR_PARAM ? resolveErrorValue(ownValue) : ownValue);

    toasts.push({ tone: "error", message });
    stripParams.push(name);
    claimed.add(name);

    if (name === ERROR_PARAM && detail !== null) {
      stripParams.push(MESSAGE_PARAM);
      claimed.add(MESSAGE_PARAM);
    }
  }

  // 2. Registry: explicit param groups for shapes the convention can't express.
  for (const group of FLASH_REGISTRY_GROUPS) {
    const representative = group[0];
    if (representative.params.some((p) => claimed.has(p))) continue;
    if (!representative.params.every((p) => params.has(p))) continue;
    if (
      representative.matchValues &&
      !Object.entries(representative.matchValues).every(([k, v]) => params.get(k) === v)
    ) {
      continue;
    }

    const winner = resolveGroupEntry(group, pathname);
    if (!winner) continue;

    const values = new Map(representative.params.map((p) => [p, params.get(p) ?? ""]));
    const tone = typeof winner.tone === "function" ? winner.tone(values) : winner.tone;
    toasts.push({ tone, message: winner.message(values) });
    for (const p of representative.params) {
      stripParams.push(p);
      claimed.add(p);
    }
  }

  return { toasts, stripParams };
}
