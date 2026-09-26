/**
 * The requests Vercel BotID classifies. Shared by the browser, which attaches
 * the BotID headers only to requests matching this list, and by the server
 * checks, which fail (every caller looks like a bot) on any request the browser
 * was not told to protect.
 *
 * Server Actions POST to the page that renders the form, so these are page
 * paths, not action names. Both magic-link forms are here because they are the
 * only unauthenticated requests that send email: a script looping them drains
 * the mail provider's send quota and floods the victim's inbox.
 *
 * "/" is the applicant sign-in on the portal host, where the proxy rewrites the
 * bare root onto /apply; the browser only ever sees the un-rewritten path.
 */
export const BOTID_PROTECTED_ROUTES = [
  { path: "/login", method: "POST" },
  { path: "/apply", method: "POST" },
  { path: "/", method: "POST" },
] as const;
