import Link from "next/link";
import { getSetting } from "@/platform/settings/service";
import { formatCopyright } from "@/platform/branding/attribution";
import { formatOrgLine, type OrgIdentity } from "@/platform/branding/org";
import { cx } from "./cx";

/** Content-column widths, matched to the shell each footer sits in. */
const WIDTHS = {
  app: "max-w-6xl",
  wide: "max-w-4xl",
  prose: "max-w-2xl",
} as const;

export type FooterWidth = keyof typeof WIDTHS;

/**
 * Text colors per backdrop. `onBrand` is for the sign-in screen, where the notice
 * sits over a dark brand photograph rather than the canvas. Kept as explicit
 * variants because the project deliberately runs without tailwind-merge, so a
 * caller-supplied `text-*` class cannot be relied on to beat the default.
 */
const TONES = {
  default: { body: "text-subtle-foreground", link: "hover:text-foreground" },
  onBrand: { body: "text-white/70", link: "hover:text-white" },
} as const;

export type FooterTone = keyof typeof TONES;

async function resolveOrgName(): Promise<string> {
  try {
    return await getSetting<string>("branding.orgName");
  } catch {
    // The footer renders on the 404 page and inside error boundaries, where the
    // database may be the thing that failed. Fall back to the default name so a
    // settings blip degrades the notice rather than taking down the whole page.
    return "HAVEN Free Clinic";
  }
}

/**
 * The bare copyright line and its link to the credits, with no surrounding
 * chrome. Use this on the centered card layouts (sign-in, 404) that place their
 * own trailing text; use AppFooter for the column layouts.
 */
export async function CopyrightNotice({
  className,
  tone = "default",
}: {
  className?: string;
  /** Backdrop the notice sits on. Use `onBrand` over the sign-in photograph. */
  tone?: FooterTone;
}) {
  const orgName = await resolveOrgName();
  // `new Date()` rather than Date.now(): the latter is flagged as impure inside a
  // component body by react-hooks/purity, including in async Server Components.
  const year = new Date().getFullYear();
  const { body, link } = TONES[tone];
  return (
    <p className={cx("text-xs", body, className)}>
      {formatCopyright(orgName, year)}
      {" · "}
      <Link
        href="/attributions"
        className={cx(
          "rounded-sm underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand",
          link,
        )}
      >
        Attributions
      </Link>
    </p>
  );
}

/**
 * The bordered footer bar closing out a column layout. Shared by the signed-in
 * AppShell and the public portals so the copyright notice and its credits link
 * appear on every page of the app, authenticated or not.
 */
export async function AppFooter({
  width = "prose",
  org,
}: {
  /** Content-column width, matched to the shell's own main element. */
  width?: FooterWidth;
  /** When given, the clinic identity line rendered above the copyright notice. */
  org?: OrgIdentity;
}) {
  return (
    <footer className="border-t border-border-subtle">
      <div className={cx("mx-auto w-full px-6 py-8", WIDTHS[width])}>
        {org && <p className="text-xs text-subtle-foreground">{formatOrgLine(org)}</p>}
        <CopyrightNotice className={org ? "mt-1" : undefined} />
      </div>
    </footer>
  );
}
