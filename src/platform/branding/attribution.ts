/**
 * Authorship of HAVEN Hub itself: the copyright line carried in every footer and
 * the credits behind it. Distinct from `org.ts`, which describes the clinic the
 * Hub serves -- this module describes who built the software.
 */

/**
 * A person credited on the /attributions page. `email` is optional: alumni are
 * credited for the role they held, and a lapsed Yale address is worse than no
 * contact link at all.
 */
export type Contributor = {
  name: string;
  role: string;
  email?: string;
};

/**
 * The people who built and maintain the Hub, in the order they are listed.
 * Hardcoded rather than settings-backed: this is authorship of the source, not
 * clinic configuration, so it changes with the code and belongs in the code.
 */
export const CONTRIBUTORS: readonly Contributor[] = [
  {
    name: "Jack Carney",
    role: "Director of IT and Communications",
    email: "j.carney@yale.edu",
  },
  {
    name: "Caprice Culkin",
    role: "Director of IT and Communications",
    email: "caprice.culkin@yale.edu",
  },
  {
    name: "Renée Tracey",
    role: "Director of IT and Communications",
    email: "renee.tracey@yale.edu",
  },
  {
    name: "Antigone Antonakakis",
    role: "Executive Director, 2025-2026",
  },
];

/**
 * The team that holds the copyright, derived from the configurable organization
 * name so a rebrand carries through the same way it does everywhere else
 * (branding.orgName). With the default setting this reads "HAVEN Free Clinic IT
 * Department".
 */
export function copyrightHolder(orgName: string): string {
  return `${orgName.trim()} IT Department`;
}

/**
 * The full notice, e.g. "© Copyright 2026 HAVEN Free Clinic IT Department".
 * Callers pass the year rather than reading the clock here, so this stays a pure
 * function and server components can source it from `new Date()` in their body
 * (`Date.now()` trips the react-hooks/purity rule).
 */
export function formatCopyright(orgName: string, year: number): string {
  return `© Copyright ${year} ${copyrightHolder(orgName)}`;
}
