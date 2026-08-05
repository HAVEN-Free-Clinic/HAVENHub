import type { Ref } from "react";
import Link from "next/link";

export type TabItem = { label: string; href: string; badge?: number };

/**
 * Bring a row's active tab into horizontal view WITHOUT scrolling anything else.
 *
 * Do NOT use `Element.scrollIntoView` for this. It scrolls EVERY scrollable
 * ancestor as needed, up to and including the document; `block: "nearest"`
 * only chooses the alignment, not which ancestors move. A long-standing
 * comment in this codebase claimed the opposite ("nearest only scrolls the tab
 * row, never the page"), and acting on it is what made every cycle page nudge
 * the document on load. That shift raced Playwright's click on Publish: the
 * button moved between the actionability check and the click, the publish
 * never fired, and five recruitment specs went red on an unrelated assertion
 * (the OPEN badge). See the isolation experiment in PRs #510 and #511.
 *
 * Adjusting the row's own `scrollLeft` is strictly horizontal and strictly
 * scoped to the row, so it cannot move the page or shift a control out from
 * under a cursor.
 */
export function scrollActiveTabIntoView(nav: HTMLElement | null): void {
  const active = nav?.querySelector<HTMLElement>('[aria-current="page"]');
  if (!nav || !active) return;
  const row = nav.getBoundingClientRect();
  const tab = active.getBoundingClientRect();
  if (tab.left < row.left) {
    nav.scrollLeft -= row.left - tab.left;
  } else if (tab.right > row.right) {
    nav.scrollLeft += tab.right - row.right;
  }
}

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
  navRef,
}: {
  items: TabItem[];
  isActive: (item: TabItem) => boolean;
  variant?: "underline" | "segmented";
  label: string;
  /**
   * Optional ref to the root `<nav>` element. Lets a client-component caller
   * (this primitive itself is not "use client") reach into the rendered row,
   * e.g. to scroll the active tab into view. Nothing here reads or writes it;
   * it is only ever attached to the DOM node.
   */
  navRef?: Ref<HTMLElement>;
}) {
  if (items.length === 0) return null;

  if (variant === "segmented") {
    return (
      <nav
        ref={navRef}
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
      ref={navRef}
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
