/**
 * Derive the current module from a pathname and build the GitBook assistant's greeting
 * and suggested questions. Pure and React-free so it is unit-testable and reusable.
 *
 * `moduleLabels` maps a top-level route segment (== module id, e.g. "recruitment") to its
 * human title (e.g. "Recruitment"), built server-side from MODULES and passed to the client.
 */
export interface HelpSeed {
  greeting: { title: string; subtitle: string };
  suggestions: string[];
  moduleTitle: string | null;
}

const GENERIC_GREETING = {
  title: "How can we help?",
  subtitle: "Search the docs or ask a question.",
};

const GENERIC_SUGGESTIONS = ["How do I use HAVEN Hub?", "Where do I update my info?"];

/** The module title for a pathname's first segment, or null when unknown / at the root. */
export function moduleTitleForPath(
  pathname: string,
  moduleLabels: Record<string, string>
): string | null {
  const segment = pathname.split("/").filter(Boolean)[0];
  if (!segment) return null;
  return moduleLabels[segment] ?? null;
}

/** Greeting + suggestions seeded from the current module (generic fallback off a module). */
export function seedForPathname(
  pathname: string,
  moduleLabels: Record<string, string>
): HelpSeed {
  const moduleTitle = moduleTitleForPath(pathname, moduleLabels);
  if (!moduleTitle) {
    return { greeting: GENERIC_GREETING, suggestions: GENERIC_SUGGESTIONS, moduleTitle: null };
  }
  return {
    greeting: {
      title: `${moduleTitle} help`,
      subtitle: `Ask about ${moduleTitle} or search the docs.`,
    },
    suggestions: [`How does ${moduleTitle} work?`, `What can I do in ${moduleTitle}?`],
    moduleTitle,
  };
}
