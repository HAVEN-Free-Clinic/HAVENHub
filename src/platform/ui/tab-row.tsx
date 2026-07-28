import Link from "next/link";

export type TabItem = { label: string; href: string; badge?: number };

/**
 * Shared horizontal tab-row primitive. Presentational only: it takes
 * `isActive` as a prop instead of computing it from the pathname, because the
 * consumers disagree on what "active" means (module nav prefix-matches
 * sub-paths, the Epic tabs compare a `?tab=` search param, the cycle nav
 * exact-matches). Renders `next/link` (not click handlers) so internal
 * navigation stays a soft nav. Not a "use client" component -- consumers that
 * need usePathname stay client components and pass the computed result down,
 * which keeps this primitive server-renderable.
 */
export function TabRow({
  items,
  isActive,
  variant = "underline",
  label,
}: {
  items: TabItem[];
  isActive: (item: TabItem) => boolean;
  variant?: "underline" | "segmented";
  label: string;
}) {
  if (items.length === 0) return null;

  if (variant === "segmented") {
    return (
      <nav
        aria-label={label}
        className="flex gap-1 overflow-x-auto rounded-lg bg-muted p-1 text-sm [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {items.map((item) => {
          const active = isActive(item);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              aria-label={item.badge === undefined ? undefined : `${item.label}, ${item.badge}`}
              className={
                active
                  ? "shrink-0 whitespace-nowrap rounded-lg bg-surface px-3 py-1.5 text-foreground shadow-sm"
                  : "shrink-0 whitespace-nowrap rounded-lg px-3 py-1.5 text-muted-foreground hover:text-foreground"
              }
            >
              {item.label}
              {item.badge !== undefined && (
                <span aria-hidden className="ml-1.5 rounded-full bg-border px-1.5 py-0.5 text-xs">
                  {item.badge}
                </span>
              )}
            </Link>
          );
        })}
      </nav>
    );
  }

  return (
    <nav
      aria-label={label}
      className="flex gap-6 overflow-x-auto border-b border-border text-sm [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {items.map((item) => {
        const active = isActive(item);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            aria-label={item.badge === undefined ? undefined : `${item.label}, ${item.badge}`}
            className={
              active
                ? "shrink-0 whitespace-nowrap border-b-2 border-brand pb-2 text-brand-fg font-medium"
                : "shrink-0 whitespace-nowrap pb-2 text-muted-foreground hover:text-foreground"
            }
          >
            {item.label}
            {item.badge !== undefined && (
              <span aria-hidden className="ml-1.5 rounded-full bg-border px-1.5 py-0.5 text-xs">
                {item.badge}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
