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
 *    `blank-description` / `future-date` / `person-not-found`) is deliberately excluded from the
 *    shared table; those pages are ruled INLINE and keep their own rendering, and (see
 *    "Suppression" below) never reach this table at all for their `error` param.
 * 2. Registry: an explicit table for everything the convention cannot express -- a flag param
 *    whose text the page hardcodes (`saved` -> "Saved."), or a group of params a page composes
 *    into one sentence (`sent` + `skipped` -> one release summary). A registry entry only fires
 *    when every param it owns is present, which matters: `sent` alone means something completely
 *    different on outreach/campaigns/[id]/page.tsx ("Campaign sent to N recipients") than it
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
 * A registry entry -- and a code-table entry, below -- may therefore carry an optional
 * `pathnames` scope: a list of `PathnameScope`s (a path pattern where `*` matches exactly one
 * segment, optionally paired with literal pathnames to exclude from it) that restrict where the
 * entry applies. Entries sharing the same key (a param set + `matchValues` for the registry, an
 * error code for the table) form a group, resolved by the shared `resolveScoped` helper: within a
 * group, a scoped entry wins on a matching pathname, and the group's one unscoped entry (if any)
 * is the default everywhere else. A group with no unscoped entry and no matching scoped entry
 * simply does not fire -- there is nothing to fall back to, which is correct: a param this
 * page-specific should never guess.
 *
 * `not-found` is a confirmed real conflict between `incidents/[id]/page.tsx` ("The incident report
 * could not be found.") and `incidents/strikes/page.tsx` ("The disciplinary action could not be
 * found."). Registered as a pathname-scoped code-table entry below, using a scope that excludes
 * the known static siblings under `/incidents/` (see `PathnameScope`'s `except`) so the
 * dynamic-segment pattern cannot leak onto the wrong one. See the `ERROR_CODE_TABLE` doc comment
 * for exactly which pathname it actually needs to include.
 *
 * ---
 *
 * **The applicant portal host needs a caller-side fix, not a wider scope.**
 * `apply.havenfreeclinic.org` (`PORTAL_BASE_URL`) is served by `src/proxy.ts` rewriting a clean
 * portal URL -- `/some-slug`, or bare `/` for the portal home -- onto the existing `/apply` route
 * tree (`/apply/some-slug`, `/apply`) via `NextResponse.rewrite`. A rewrite never changes the
 * browser's URL, so on that host `usePathname()` reports the PRE-rewrite path (`/`, `/some-slug`),
 * not the effective route (`/apply`, `/apply/some-slug`) that this module's `/apply`-scoped
 * entries (like `link`, in the code table) are written against. The proxy's `x-pathname` request
 * header (`proxy.ts:19`) captures that same pre-rewrite path, not the rewritten one, so reading
 * the pathname from that header instead of `usePathname()` alone does not fix this either -- both
 * report `/`.
 *
 * Deliberately NOT fixed by also scoping `/apply` entries onto `/`: `/` is the signed-in app's own
 * dashboard (`(app)/page.tsx`), the single busiest page in the product, reads no `searchParams` at
 * all today, and would still be a live target for the pathname-blind `error` convention above --
 * scoping `link`'s very specific applicant-facing text onto `/` risks a wrong toast on the app's
 * main page the moment anything ever puts a stray `?error=link` there, which is a worse trade than
 * leaving this unresolved for one release.
 *
 * **So this is left as a caller-side requirement, not solved in this module:** whoever wires up
 * the reader (the mounting task) must resolve the EFFECTIVE route pathname before calling
 * `classifyFlashParams`, not pass `usePathname()`'s raw value straight through. On the portal host
 * (request host equals `PORTAL_BASE_URL`), apply the same mapping the proxy itself uses --
 * `rewriteToApply` from `@/modules/recruitment/services/portal-routing` (`/` -> `/apply`, `/x` ->
 * `/apply/x`) -- to the pre-rewrite path before passing it in. Everywhere else, `usePathname()` is
 * already correct and needs no translation.
 *
 * ---
 *
 * **Suppression (added after Task 4's mounting plan surfaced a real double-report).** The base
 * `error`/`*Error` convention is otherwise pathname-blind: any page whose URL carries `error` gets
 * it classified, whether or not that page still renders its own inline `<Alert>` for it. Once a
 * global reader mounts in the root layout, an unsuppressed page would pop a second, often
 * wrongly-worded toast right alongside its own correct inline render -- the exact double-report
 * the design spec's migration rule forbids. There are two suppression mechanisms, chosen by how
 * much of a pathname's `error` vocabulary the page renders inline itself:
 *
 * 1. **Whole-param, `SUPPRESSED_ERROR_PARAMS`, keyed by (pathname, param).** For a page that owns
 *    ALL of the error codes it can ever receive on that pathname, so the convention must never
 *    fire there at all. Three pages are ruled INLINE in the page inventory for this reason, each
 *    owning error-code vocabulary this module cannot safely resolve (a mix of shared and
 *    page-specific codes it cannot split by value): `login/page.tsx` (NextAuth's own codes),
 *    `incidents/page.tsx`, and `incidents/strikes/page.tsx`. `SUPPRESSED_ERROR_PARAMS` lists the
 *    precise (pathname, param) pairs from the inventory's INLINE rulings, not whole pages:
 *    `incidents/page.tsx` is INLINE only for its `error`/`message` pair, and if it ever gains
 *    another flash param later, a whole-page opt-out would have silently swallowed that too. A
 *    suppressed pair is left completely alone -- not claimed, not stripped, not toasted -- exactly
 *    like a param nobody registered at all. `message` needs no separate suppression entry: it is
 *    only ever claimed as `error`'s companion inside the same loop iteration, so skipping `error`
 *    already leaves `message` untouched.
 * 2. **Single-value, `SUPPRESSED_ERROR_VALUES`, keyed by (pathname, param, value).** For a page
 *    that renders inline UI for only SOME of the codes a pathname can receive, and still needs the
 *    toast for the rest. `apply/page.tsx` is the confirmed case: it renders its own inline
 *    `<Alert>` for `error=signin` (a failed Yale sign-in) but has no inline handling for
 *    `error=link` (`apply/verify/page.tsx`'s expired-magic-link redirect), which must keep
 *    resolving through the `ERROR_CODE_TABLE`'s `link` entry and popping as a toast. A whole-param
 *    entry for `("/apply", "error")` in `SUPPRESSED_ERROR_PARAMS` would suppress `link` too --
 *    confirmed by a broken test when this was tried -- so `signin` is registered in
 *    `SUPPRESSED_ERROR_VALUES` instead, leaving every other value of `error` on `/apply`
 *    untouched. Reach for this form whenever a page's suppression need does not extend to every
 *    code the pathname can produce.
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
 * Treats an empty string value the same as an absent param: `?error=` must not toast an empty
 * message, and `?error=validation&message=` must not let an empty `message` beat the code table's
 * real text for `validation` (`params.get` returns `""`, which is non-null, so a plain `?? ""`
 * fallback was letting it through).
 */
function hasValue(params: URLSearchParams, name: string): boolean {
  const value = params.get(name);
  return value !== null && value !== "";
}

/** Strips one trailing slash (but never reduces a bare "/" to ""), so `/login/` still suppresses
 * exactly like `/login`. `next.config.ts` sets neither `trailingSlash` nor `basePath`, so this
 * cannot happen from this app's own routing today, but scope/suppression matching is exact-string,
 * and suppression failing open is a spec violation, not a cosmetic miss, so it costs one line to
 * close off regardless. */
function normalizePathname(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

/**
 * A pathname scope: either a plain pattern string (`*` matches exactly one path segment), or a
 * pattern paired with an explicit list of literal pathnames to exclude from it.
 *
 * `except` exists because a bare `*` cannot, on its own, distinguish a Next.js dynamic route
 * segment (e.g. `/incidents/[id]`) from a static sibling route at the same position (e.g.
 * `/incidents/strikes`) -- a wildcard in that position matches both equally. Next.js itself
 * resolves this by giving the static route precedence over the dynamic one; `except` is this
 * module's equivalent, spelled out explicitly rather than inferred, since this module has no
 * access to the app's actual route table.
 */
type PathnameScope = string | { readonly pattern: string; readonly except: readonly string[] };

function scopePattern(scope: PathnameScope): string {
  return typeof scope === "string" ? scope : scope.pattern;
}

/** `*` matches exactly one path segment (e.g. a dynamic route id); every other segment is literal. */
function matchesPathname(pattern: string, pathname: string): boolean {
  const patternSegments = pattern.split("/");
  const pathSegments = pathname.split("/");
  if (patternSegments.length !== pathSegments.length) return false;
  return patternSegments.every((segment, i) => segment === "*" || segment === pathSegments[i]);
}

function matchesScope(scope: PathnameScope, pathname: string): boolean {
  if (typeof scope !== "string" && scope.except.includes(pathname)) return false;
  return matchesPathname(scopePattern(scope), pathname);
}

/**
 * Resolves which of a group of pathname-scoped candidates (sharing whatever key the caller
 * already filtered on -- a param set for the registry, an error code for the table below) applies
 * on the given pathname: a matching scoped candidate wins; otherwise the group's one unscoped
 * candidate (if any) is the default; otherwise nothing applies.
 */
function resolveScoped<T extends { pathnames?: readonly PathnameScope[] }>(
  candidates: readonly T[],
  pathname: string,
): T | null {
  const scoped = candidates.find((c) => c.pathnames?.some((scope) => matchesScope(scope, pathname)));
  if (scoped) return scoped;
  return candidates.find((c) => c.pathnames === undefined) ?? null;
}

type ErrorCodeEntry = {
  code: string;
  text: string;
  pathnames?: readonly PathnameScope[];
};

/**
 * The bare `error` param's shared code vocabulary: codes whose text is identical everywhere they
 * are confirmed to appear, plus the one confirmed real conflict (`not-found`), pathname-scoped.
 *
 * Deliberately excluded: every page-owned code (`subject-not-found`, `bad-category`,
 * `blank-description`, `future-date`, `person-not-found`, NextAuth's `CredentialsSignin` /
 * `MemberLinkExpired`). Do not add `lastError` here or anywhere in this module: it is a
 * `TeamsMessage` / `EmailLog` database column (`row.lastError`), never a URL param. It reached the
 * design spec's own suffixed-error list by mistake; the `/Error$/` convention would still
 * (harmlessly, since nothing ever sets it on a URL) claim it as raw text if it ever showed up
 * there, exactly like the other 85 sites.
 *
 * `validation`'s text is copied from the three incidents pages' `ERROR_MESSAGES["validation"]`
 * rather than `admin/notifications` / `admin/email`'s generic "An unexpected error occurred.".
 * This is a real, if practically unreachable, difference: every live redirect to `error=validation`
 * also sets `message` (confirmed by grep), so this table is only ever consulted for `validation`
 * on the one page that reaches it message-less (`incidents/strikes/page.tsx:223`, which is
 * INLINE-ruled but happens to carry byte-identical text to this entry regardless).
 *
 * `not-found`'s only live producers redirect to `/incidents/review` (`incidents/actions.ts:134,162`)
 * or `/incidents/strikes` (`incidents/strikes/page.tsx:282,306`); nothing redirects to
 * `/incidents/[id]?error=not-found` today (confirmed by grep). `incidents/actions.ts:102`'s own
 * comment says why: "a missing report bounces to the review queue instead", so `/incidents/review`
 * is exactly where "The incident report could not be found." belongs, and it is deliberately
 * INCLUDED under the `/incidents/*` wildcard rather than excluded (an earlier version of this
 * table excluded it, which meant the one live site that receives this code got the raw slug
 * "not-found" instead of real text). `/incidents/mine` stays excluded (it never receives this
 * code). `/incidents/strikes` stays excluded too, but has no dedicated table entry of its own for
 * its different text ("The disciplinary action could not be found.") -- `SUPPRESSED_ERROR_PARAMS`
 * below suppresses the whole `error` param on that pathname before any code lookup ever runs, so a
 * separate entry would be permanently unreachable and therefore untestable: a wrong edit to its
 * string would fail nothing, and it would silently activate only if someone removed the
 * suppression entry without checking here too. The conflict stays documented here and in the
 * inventory instead.
 *
 * `link` is `/apply`'s one slug code (`apply/verify/page.tsx:44` -> `apply/page.tsx:54-56`), the
 * public, unauthenticated first-touch surface of the app. See the module doc comment's
 * "applicant portal host" paragraph before assuming a plain `/apply` scope is sufficient at the
 * call site.
 */
const ERROR_CODE_TABLE: readonly ErrorCodeEntry[] = [
  { code: "forbidden", text: "You do not have permission for that action." },
  { code: "validation", text: "Please check your input and try again." },
  {
    code: "link",
    text: "That link has expired or was already used. Request a new one below.",
    pathnames: ["/apply"],
  },
  {
    code: "not-found",
    text: "The incident report could not be found.",
    pathnames: [
      {
        pattern: "/incidents/*",
        except: ["/incidents/mine", "/incidents/strikes"],
      },
    ],
  },
];

function resolveErrorValue(rawValue: string, pathname: string): string {
  const candidates = ERROR_CODE_TABLE.filter((entry) => entry.code === rawValue);
  const resolved = resolveScoped(candidates, pathname);
  return resolved ? resolved.text : rawValue;
}

/**
 * Precise (pathname, param) pairs where the `error`/`*Error` convention must not fire at all,
 * because the page is ruled INLINE in the page inventory. See the module doc comment.
 *
 * Do NOT add `incidents/[id]/page.tsx` here: it is ruled TOAST (SHARED CODES), not INLINE -- every
 * one of its codes (`forbidden`, `not-found`, `validation`) is in the shared vocabulary above.
 */
const SUPPRESSED_ERROR_PARAMS: ReadonlySet<string> = new Set(
  ([
    ["/login", "error"],
    ["/incidents", "error"],
    ["/incidents/strikes", "error"],
  ] as const).map(([pathname, name]) => suppressionKey(pathname, name)),
);

/** Composite Set key. A space is a safe delimiter because neither a URL pathname nor a param
 *  name can contain a literal one (a space arrives percent-encoded). Do not "harden" this to
 *  a NUL byte: a single \0 anywhere makes grep, ripgrep, and most editors treat this entire
 *  file as binary, so it silently disappears from every repo-wide search. */
function suppressionKey(pathname: string, name: string): string {
  return `${pathname} ${name}`;
}

function isSuppressedErrorParam(pathname: string, name: string): boolean {
  return SUPPRESSED_ERROR_PARAMS.has(suppressionKey(pathname, name));
}

/**
 * Precise (pathname, param, value) triples where the `error` convention must not fire for that
 * ONE value, leaving every other value of the same param on the same pathname to resolve
 * normally. This is `SUPPRESSED_ERROR_PARAMS`'s narrower sibling: that set suppresses a param
 * unconditionally because the whole page owns its error vocabulary (`/login`'s NextAuth codes,
 * the `/incidents` pages' mixed vocabulary); a blanket entry there would be wrong for a page that
 * only inline-renders SOME of its error codes.
 *
 * `apply/page.tsx` renders its own inline `<Alert>` only for `error=signin` (a failed Yale
 * sign-in). `error=link` is `/apply`'s OTHER error code (`apply/verify/page.tsx:44`'s
 * expired/already-used magic-link redirect) and is NOT rendered inline anywhere -- it depends on
 * this module popping a toast via the `ERROR_CODE_TABLE`'s `link` entry above. A blanket
 * `["/apply", "error"]` entry in `SUPPRESSED_ERROR_PARAMS` would silently swallow that toast too
 * (confirmed: it broke the "resolves error=link on /apply to its real text" test), so `signin`
 * needs its own value-scoped suppression instead.
 */
const SUPPRESSED_ERROR_VALUES: ReadonlySet<string> = new Set(
  ([["/apply", "error", "signin"]] as const).map(([pathname, name, value]) =>
    suppressionValueKey(pathname, name, value),
  ),
);

function suppressionValueKey(pathname: string, name: string, value: string): string {
  return `${pathname} ${name} ${value}`;
}

function isSuppressedErrorValue(pathname: string, name: string, value: string): boolean {
  return SUPPRESSED_ERROR_VALUES.has(suppressionValueKey(pathname, name, value));
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
   * Optional pathname scope: a list of `PathnameScope`s this entry applies to. Omitted means
   * unscoped -- the default for its param group, used wherever no scoped sibling in the same
   * group matches. See the module doc comment for the full resolution rule.
   */
  pathnames?: readonly PathnameScope[];
};

/** recruitment/cycles/[id]/applicants/[applicationId]/page.tsx's own route. */
const APPLICANT_DETAIL_PATHNAME = "/recruitment/cycles/*/applicants/*";
/** recruitment/interviews/[interviewId]/page.tsx's own route. */
const INTERVIEW_DETAIL_PATHNAME = "/recruitment/interviews/*";

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
 *
 * The same rule is why every `saved`-with-a-literal-value entry below (`saved=decision`,
 * `saved=reopened`, ...) is declared BEFORE the plain, value-agnostic `saved` group further down:
 * the plain group's `matchValues` is undefined, so it satisfies "no literal-value requirement" for
 * ANY value of `saved`, including "decision" -- if it ran first on the applicants/interviews pages
 * it would claim `saved` with the generic "Saved." text before the matchValues-specific groups
 * ever got a look, and per-param claiming (`claimed.add`) would then block them from ever firing.
 *
 * **`my-info/page.tsx`'s `withdrawn` is deliberately absent from this table.**
 * `MembershipsCard` only shows its banner when `withdrawn > 0` (withdrawFromTerm returns 0 when
 * the member has no active-term volunteer membership to withdraw, e.g. no active term at all);
 * the registry's `hasValue()` gate treats `withdrawn=0` as present just like any other value, so
 * a plain entry here would show "Withdrawn from 0 volunteer assignment(s) this term." in a case
 * the page always meant to stay silent. That render-or-not decision is not something a `message()`
 * builder can express, so `withdrawn` keeps composing its own text and calls `useToast()` directly
 * from a small client component (`modules/my-info/components/withdrawn-toast.tsx`), exactly the
 * carve-out the design spec's own amendment describes. Since this classifier never claims
 * `withdrawn`, it is never stripped from the URL either -- the same as it was never stripped
 * before this migration, when the page rendered its own inline `<Alert>` straight off
 * `searchParams`.
 */
const FLASH_REGISTRY: readonly FlashRegistryEntry[] = [
  // ---------------------------------------------------------------------------
  // saved=<value> literal-value groups, applicants/interviews detail pages. Each
  // is its own group (a non-empty `matchValues` makes its groupKey distinct from
  // the plain `saved` group below) and must be declared first -- see the doc
  // comment above.
  // ---------------------------------------------------------------------------
  {
    // recruitment/cycles/[id]/applicants/[applicationId]/page.tsx:261 and
    // recruitment/interviews/[interviewId]/page.tsx:30-37 (savedMessage.decision). Byte-identical
    // text on both pages, so one entry covers both.
    params: ["saved"],
    matchValues: { saved: "decision" },
    pathnames: [APPLICANT_DETAIL_PATHNAME, INTERVIEW_DETAIL_PATHNAME],
    tone: "success",
    message: () => "Decision recorded.",
  },
  {
    // recruitment/cycles/[id]/applicants/[applicationId]/page.tsx:262 (reopenDecisionAction).
    // Only the applicants page ever reaches this value.
    params: ["saved"],
    matchValues: { saved: "reopened" },
    pathnames: [APPLICANT_DETAIL_PATHNAME],
    tone: "success",
    message: () => "Decision reopened.",
  },
  {
    // recruitment/cycles/[id]/applicants/[applicationId]/page.tsx:263 and
    // recruitment/interviews/[interviewId]/page.tsx:30-37 (savedMessage.rescind). Byte-identical
    // text on both pages.
    params: ["saved"],
    matchValues: { saved: "rescind" },
    pathnames: [APPLICANT_DETAIL_PATHNAME, INTERVIEW_DETAIL_PATHNAME],
    tone: "success",
    message: () => "Acceptance rescinded.",
  },
  {
    // recruitment/interviews/[interviewId]/page.tsx:30-37 (savedMessage.schedule).
    params: ["saved"],
    matchValues: { saved: "schedule" },
    pathnames: [INTERVIEW_DETAIL_PATHNAME],
    tone: "success",
    message: () => "Schedule saved.",
  },
  {
    // recruitment/interviews/[interviewId]/page.tsx:30-37 (savedMessage.panelist).
    params: ["saved"],
    matchValues: { saved: "panelist" },
    pathnames: [INTERVIEW_DETAIL_PATHNAME],
    tone: "success",
    message: () => "Panel updated.",
  },
  {
    // recruitment/interviews/[interviewId]/page.tsx:30-37 (savedMessage.invite).
    params: ["saved"],
    matchValues: { saved: "invite" },
    pathnames: [INTERVIEW_DETAIL_PATHNAME],
    tone: "success",
    message: () => "Invite sent.",
  },
  {
    // recruitment/interviews/[interviewId]/page.tsx:30-37 (savedMessage.evaluation).
    params: ["saved"],
    matchValues: { saved: "evaluation" },
    pathnames: [INTERVIEW_DETAIL_PATHNAME],
    tone: "success",
    message: () => "Evaluation saved.",
  },

  // ---------------------------------------------------------------------------
  // Plain, value-agnostic `saved` group: one flag, whatever text the owning
  // page hardcodes. Must come after the literal-value groups above.
  // ---------------------------------------------------------------------------
  {
    // Seen across ~15 pages, e.g. admin/settings/page.tsx:68,140. This is the right text for
    // roughly five of them; every page with its own wording needs a scoped sibling entry below
    // (or, for a param this classifier does not claim at all, an exclusion), NOT a useToast()
    // escape hatch: the reader mounts in the root layout and claims a redirect-driven `saved`
    // unconditionally the moment it is present on the URL, before the page itself ever runs, so
    // there is no way for a page to "opt out" of a param this classifier already claims.
    // useToast() only helps a client-side action that never touches the URL in the first place.
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
    // admin/departments/[id]/page.tsx (via department-form.tsx:32) and
    // admin/subcommittees/[id]/page.tsx (via subcommittee-form.tsx:21). Byte-identical text.
    params: ["saved"],
    pathnames: ["/admin/departments/*", "/admin/subcommittees/*"],
    tone: "success",
    message: () => "Changes saved.",
  },
  {
    // recruitment/cycles/[id]/subcommittees/page.tsx:47.
    params: ["saved"],
    pathnames: ["/recruitment/cycles/*/subcommittees"],
    tone: "success",
    message: () => "Assignment saved.",
  },
  {
    // outreach/campaigns/[id]/page.tsx:310-312.
    params: ["saved"],
    pathnames: ["/outreach/campaigns/*"],
    tone: "success",
    message: () => "Campaign saved.",
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
    // outreach/campaigns/[id]/page.tsx:227-228,317-320. A standalone recipient count, never
    // paired with `skipped` or `promoted` -- declared last among the `sent`-owning groups (see
    // the doc comment above) and pathname-scoped as a second guard.
    params: ["sent"],
    pathnames: ["/outreach/campaigns/*"],
    tone: "success",
    message: (values) => {
      const sent = values.get("sent") ?? "";
      return `Campaign sent to ${sent} ${sent === "1" ? "recipient" : "recipients"}.`;
    },
  },
  {
    // outreach/campaigns/[id]/page.tsx:416-418 (testAction).
    params: ["tested"],
    pathnames: ["/outreach/campaigns/*"],
    tone: "success",
    message: () => "Test email sent to your address.",
  },
  {
    // outreach/campaigns/[id]/page.tsx:404-413 (previewAction). All three params always
    // arrive together -- the redirect sets count and excluded every time, even at 0 -- so
    // requiring all three is not an artificial restriction, just what the producer always sends.
    params: ["preview", "count", "excluded"],
    pathnames: ["/outreach/campaigns/*"],
    tone: "info",
    message: (values) => {
      const count = values.get("count") ?? "0";
      const excluded = values.get("excluded") ?? "0";
      const excludedCount = Number(excluded);
      return `Audience preview: ${count} recipient${count !== "1" ? "s" : ""}${
        excludedCount > 0 ? `, ${excluded} excluded (no email address on file)` : ""
      }.`;
    },
  },
  {
    // outreach/campaigns/[id]/page.tsx:318-320 (scheduleLaterAction/scheduleRecurringAction).
    params: ["scheduled"],
    pathnames: ["/outreach/campaigns/*"],
    tone: "success",
    message: () => "Campaign scheduled.",
  },
  {
    // outreach/campaigns/[id]/page.tsx:321-323 (cancelAction).
    params: ["cancelled"],
    pathnames: ["/outreach/campaigns/*"],
    tone: "info",
    message: () => "Schedule cancelled.",
  },
  {
    // admin/email/page.tsx:304-306 (retryAction). "Email re-queued.", distinct from
    // admin/notifications' own `retried` text below -- same param name, two owning pages, no
    // unscoped default, so it does nothing if it ever showed up somewhere else.
    params: ["retried"],
    pathnames: ["/admin/email"],
    tone: "success",
    message: () => "Email re-queued.",
  },
  {
    // admin/notifications/page.tsx:171-173 (retryAction).
    params: ["retried"],
    pathnames: ["/admin/notifications"],
    tone: "success",
    message: () => "Teams message re-queued.",
  },
  {
    // admin/email/page.tsx:117-119,307-311 (retryAllAction). retryAllAction always redirects
    // with whatever count retryAllFailedEmails returns, which could in theory be 0 if another
    // admin's retry already cleared the queue between page render and submit -- but the only
    // button that reaches this action is hidden unless counts.retryableFailed > 0, so unlike
    // my-info's `withdrawn` (see the doc comment above), this is not treated as a genuine
    // zero-suppression case worth a useToast() escape hatch.
    params: ["retriedAll"],
    pathnames: ["/admin/email"],
    tone: "success",
    message: (values) => {
      const count = parseInt(values.get("retriedAll") ?? "0", 10) || 0;
      return `${count} failed ${count === 1 ? "email" : "emails"} re-queued.`;
    },
  },
  {
    // admin/email/page.tsx:312-314 and oauth/callback/route.ts:74.
    params: ["connected"],
    pathnames: ["/admin/email"],
    tone: "success",
    message: () => "Mailbox connected.",
  },
  {
    // admin/email/page.tsx:315-317 (saveSenderAction).
    params: ["senderSaved"],
    pathnames: ["/admin/email"],
    tone: "success",
    message: () => "Sender address saved.",
  },
  {
    // admin/email/page.tsx:318-320 (testSenderAction).
    params: ["senderTested"],
    pathnames: ["/admin/email"],
    tone: "success",
    message: () => "Test message sent. Check the inbox to confirm.",
  },
  {
    // admin/terms/[id]/page.tsx, rendered by roster-panel.tsx:285-288. `skipped` here is a
    // different shape from the sent+skipped group above (a roster-copy skip count, not a
    // conflicted-applicant count) -- disambiguated by its partner param, not its own name.
    params: ["copied", "skipped"],
    pathnames: ["/admin/terms/*"],
    tone: "success",
    message: (values) =>
      `Copied ${values.get("copied")} membership(s); ${values.get("skipped")} already existed and were skipped.`,
  },
  {
    // admin/terms/[id]/page.tsx:172, rendered by onboarding-steps-editor.tsx:74 as a plain
    // <p>, not an <Alert> -- see the module doc comment's "shape any tooling could miss" risk.
    params: ["stepsSaved"],
    pathnames: ["/admin/terms/*"],
    tone: "success",
    message: () => "Onboarding steps saved.",
  },
  {
    // my-info/page.tsx:100 and get-started/hipaa/page.tsx:50, both via hipaa-panel.tsx:184.
    // Byte-identical text on both call sites, so one entry covers both.
    params: ["certSaved"],
    pathnames: ["/my-info", "/get-started/hipaa"],
    tone: "success",
    message: () => "Certificate uploaded successfully.",
  },
  {
    // my-info/page.tsx's photoUploadAction and admin/people/[id]/page.tsx's
    // photoUploadAction, both via photo-card.tsx's upload form (member and
    // admin audiences respectively -- see that component's doc comment).
    // photoError (the failure sibling) is not a registry entry at all: it is a
    // plain `*Error`-suffixed param, so the convention above claims it with the
    // redirect's own message text, exactly like certError.
    params: ["photoSaved"],
    pathnames: ["/my-info", "/admin/people/*"],
    tone: "success",
    message: () => "Photo updated.",
  },
  {
    // my-info/page.tsx's photoRemoveAction and admin/people/[id]/page.tsx's
    // photoRemoveAction, both via photo-card.tsx's remove form -- the opt-out
    // control's own confirmation that the removal took.
    params: ["photoRemoved"],
    pathnames: ["/my-info", "/admin/people/*"],
    tone: "success",
    message: () => "Photo removed.",
  },
  {
    // recruitment/cycles/[id]/page.tsx:113 and actions.ts:134 (setCycleDepartmentsAction).
    params: ["deptsaved"],
    pathnames: ["/recruitment/cycles/*"],
    tone: "success",
    message: () => "Departments updated.",
  },
  {
    // recruitment/cycles/[id]/page.tsx:114 and actions.ts:134. Mutually exclusive with
    // deptsaved above -- the action redirects with exactly one of the two, never both.
    params: ["deptwarn"],
    pathnames: ["/recruitment/cycles/*"],
    tone: "warning",
    message: (values) =>
      `Saved. These removed departments still have applicants: ${values.get("deptwarn")}. Existing applications keep their choices, but you can no longer accept into a removed department.`,
  },
  {
    // recruitment/cycles/[id]/page.tsx:148 and actions.ts:155 (setApplicationWindowAction).
    params: ["windowsaved"],
    pathnames: ["/recruitment/cycles/*"],
    tone: "success",
    message: () => "Application window updated.",
  },
  {
    // schedule/page.tsx:210-214 (createRequestAction, line 145).
    params: ["requested"],
    pathnames: ["/schedule"],
    tone: "success",
    message: () => "Change request submitted. Your director will review it.",
  },
  {
    // incidents/mine/page.tsx:72-76 and incidents/actions.ts:95. "Report #{N} submitted.",
    // distinct from support's own `submitted` text below -- same param name, two owning
    // pages, no unscoped default.
    params: ["submitted"],
    pathnames: ["/incidents/mine"],
    tone: "success",
    message: (values) => `Report #${values.get("submitted")} submitted.`,
  },
  {
    // support/[id]/page.tsx:273-275, reached via support/new/page.tsx:75's redirect too.
    params: ["submitted"],
    pathnames: ["/support/*"],
    tone: "success",
    message: () => "Request submitted. We will keep you posted here.",
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

/**
 * Classifies the params on a URL into the toasts they should pop and the param names to strip.
 *
 * Pure: takes the params and the current pathname, returns data, touches nothing. Callers (a
 * client-side reader component) are responsible for reading `URLSearchParams` and the pathname off
 * the current URL, popping the returned toasts, and stripping the returned param names with
 * `router.replace` so a refresh does not re-fire them.
 *
 * `pathname` should be a clean path with no query string, matching `usePathname()` -- e.g.
 * `/schedule`, `/recruitment/cycles/abc123/waitlist`. (A trailing slash is normalized away, but
 * that is a defensive fallback, not a license to pass one on purpose.) It decides which
 * pathname-scoped registry or code-table entry (if any) wins for a given param group; see the
 * module doc comment for the full resolution rule, and for why `usePathname()`'s raw value is
 * NOT always the right thing to pass on the applicant portal host.
 *
 * `URLSearchParams` is also satisfied by Next.js's `ReadonlyURLSearchParams` (it extends the
 * platform type), so `useSearchParams()` can be passed straight through.
 */
export function classifyFlashParams(params: URLSearchParams, rawPathname: string): FlashClassification {
  const pathname = normalizePathname(rawPathname);
  const toasts: FlashToast[] = [];
  const stripParams: string[] = [];
  const claimed = new Set<string>();
  const names = new Set(params.keys());

  // 1. Convention: `error` and the `*Error` suffix family.
  for (const name of names) {
    if (claimed.has(name) || !isErrorConventionParam(name)) continue;
    if (!hasValue(params, name)) continue;
    if (isSuppressedErrorParam(pathname, name)) continue;

    const ownValue = params.get(name) ?? "";
    if (isSuppressedErrorValue(pathname, name, ownValue)) continue;
    const detail = name === ERROR_PARAM && hasValue(params, MESSAGE_PARAM) ? params.get(MESSAGE_PARAM) : null;
    const message = detail ?? (name === ERROR_PARAM ? resolveErrorValue(ownValue, pathname) : ownValue);

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
    if (!representative.params.every((p) => hasValue(params, p))) continue;
    if (
      representative.matchValues &&
      !Object.entries(representative.matchValues).every(([k, v]) => params.get(k) === v)
    ) {
      continue;
    }

    const winner = resolveScoped(group, pathname);
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
