/**
 * Builds a "same list, different page" URL from the search params the page was
 * rendered with.
 *
 * Every paginated list in the app hand-wrote this, once per page, by
 * re-enumerating the filters it reads: eleven near-identical URLSearchParams
 * loops. None of them is wrong today. The cost is that the enumeration is a
 * second place to remember: add a filter to a list and its pagination links go
 * on working, silently, without it. Handing the whole searchParams object to
 * one serializer removes that second place.
 *
 * It is a plain function rather than logic inside Pagination so it can be tested
 * without rendering anything, and so a page that needs a page href somewhere
 * other than the pager can reach it.
 */

/** What an awaited Next.js `searchParams` gives you, plus numbers for callers
 *  that have already parsed one. */
export type PageParams = Record<string, string | string[] | number | undefined>;

/**
 * Params that describe a one-shot event rather than the state of the list, and
 * so must NOT survive a page change.
 *
 * Server actions redirect back to a list with `?ok=Record+saved.`, `?saved=1`
 * or `?error=...`; a FlashReader claims the param and toasts it, or the page
 * renders an Alert from it. Carrying those forward would re-fire the toast on
 * every Prev/Next click, so the banner from an edit three minutes ago follows
 * the reader down the list. The hand-written builders avoided this by listing
 * only filters; a serializer that takes the whole object has to name them
 * instead.
 *
 * The names are the ones platform/ui/toast/flash.ts already treats as action
 * feedback -- `error` plus the `*Error` suffix family, `message` as `error`'s
 * detail payload, `saved`, and `ok`. Deliberately restated rather than imported:
 * flash.ts needs a pathname and carries a several-hundred-entry message registry
 * to decide what a flash param SAYS, and a URL builder only needs to know that
 * it is one. Keeping the two in step is a one-line edit; the alternative is a
 * lists helper depending on the toast layer.
 */
const TRANSIENT_PARAMS = new Set(["error", "message", "ok", "saved"]);
const TRANSIENT_SUFFIX = /Error$/;

function isTransient(name: string): boolean {
  return TRANSIENT_PARAMS.has(name) || TRANSIENT_SUFFIX.test(name);
}

/**
 * `basePath` plus `params`, with `page` set to `targetPage`.
 *
 * Rules, and why each one:
 *  - `page` from the incoming params is ignored; `targetPage` replaces it.
 *  - page 1 is written with no `page` param at all, so the first page has one
 *    canonical URL rather than two.
 *  - `undefined` and empty arrays are dropped: those are params the page does
 *    not have.
 *  - an EMPTY STRING is kept. It is a param the reader actually put in the URL,
 *    and at least one page reads it as distinct from absent (/admin/people
 *    treats a present-but-empty `status` as an explicit choice), so dropping it
 *    would quietly change which list you are looking at on page 2.
 *  - an array contributes its first element. Next gives an array when a param
 *    repeats; no list in the app reads a repeated filter, and the first value is
 *    what its own parse would have taken.
 */
export function pageHref(basePath: string, params: PageParams, targetPage: number): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (key === "page" || isTransient(key)) continue;
    const single = Array.isArray(value) ? value[0] : value;
    if (single === undefined) continue;
    search.set(key, String(single));
  }
  if (targetPage > 1) search.set("page", String(targetPage));
  const query = search.toString();
  return query ? `${basePath}?${query}` : basePath;
}
