/**
 * What a form action hands back when it refuses, instead of navigating.
 *
 * Every navigation out of the campaign editor destroys unsaved client state.
 * The compose form's subject and body live in TemplateEditor's useState, the
 * whole audience tree lives in AudienceBuilder's useState, and the recipient
 * panel's paste box lives in its own; none of it is in the DOM in a form a
 * redirect could preserve. On this route a server action that redirects
 * replaces the entire page tree below AppShell, through the Suspense boundary
 * at `src/app/(app)/loading.tsx` (measured: 6 of 6 action redirects replaced
 * it, 2 of 2 tab Link navigations did not). So an action that can REFUSE has to
 * return the reason and let the page render it in place.
 *
 * Deliberately its own module rather than an export of actions.ts: that file
 * carries "use server", where every export must be an async function. A type
 * export is erased and would almost certainly be fine, but this file has
 * already shipped one runtime failure from exporting a non-function from a
 * "use server" module, and the cost of not finding out again is one small file.
 */
export type FormProblems = { problems: string[] } | null;
