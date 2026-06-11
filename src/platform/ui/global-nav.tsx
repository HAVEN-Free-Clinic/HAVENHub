"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import { isModuleActive, type NavModule } from "@/platform/modules/access";

function linkClasses(active: boolean): string {
  return active
    ? "rounded-lg px-2.5 py-1.5 text-sm font-medium text-brand bg-brand-faint"
    : "rounded-lg px-2.5 py-1.5 text-sm font-medium text-slate-500 hover:text-slate-900 hover:bg-slate-50 transition-colors";
}

export function GlobalNav({ items }: { items: NavModule[] }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Escape closes the mobile menu and returns focus to the toggle button.
  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  if (items.length === 0) return null;

  return (
    <>
      {/* Desktop: inline links */}
      <nav aria-label="Modules" className="hidden items-center gap-1 sm:flex">
        {items.map((m) => {
          const active = isModuleActive(pathname, m.href);
          return (
            <Link
              key={m.id}
              href={m.href}
              aria-current={active ? "page" : undefined}
              className={linkClasses(active)}
            >
              {m.title}
            </Link>
          );
        })}
      </nav>

      {/* Mobile: hamburger + dropdown */}
      <div className="sm:hidden">
        <button
          ref={buttonRef}
          type="button"
          aria-label="Open navigation menu"
          aria-expanded={open}
          aria-controls="global-nav-mobile"
          onClick={() => setOpen((v) => !v)}
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
        >
          {open ? <X aria-hidden className="h-5 w-5" /> : <Menu aria-hidden className="h-5 w-5" />}
        </button>
        {open && (
          <nav
            id="global-nav-mobile"
            aria-label="Modules (menu)"
            className="absolute left-0 right-0 top-14 z-20 border-b border-slate-200 bg-white shadow-sm"
          >
            <div className="mx-auto flex max-w-6xl flex-col gap-1 px-6 py-3">
              {items.map((m) => {
                const active = isModuleActive(pathname, m.href);
                return (
                  <Link
                    key={m.id}
                    href={m.href}
                    aria-current={active ? "page" : undefined}
                    onClick={() => setOpen(false)}
                    className={`block ${linkClasses(active)}`}
                  >
                    {m.title}
                  </Link>
                );
              })}
            </div>
          </nav>
        )}
      </div>
    </>
  );
}
