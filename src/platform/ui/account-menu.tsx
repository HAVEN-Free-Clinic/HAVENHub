"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { UserRoundPen, GraduationCap, LogOut } from "lucide-react";
import { PersonPhoto } from "./person-photo";

/**
 * The account disclosure in the toolbar: personal pages (My Info, Training) and
 * sign-out. Theme deliberately stays in its own toolbar button (ThemeToggle):
 * it never competed for module-row space, and burying it would make a one-click
 * action two.
 *
 * Deliberately shows no clearance status. getOnboardingStatus costs roughly 9 DB
 * queries, which is why onboarding-gate-cache.ts caches cleared gate decisions;
 * rendering clearance here would run it on every page for every user and defeat
 * that cache. `termLabel` is already resolved by the shell, so it is free.
 *
 * `signOutAction` is passed in rather than imported so this client component
 * never pulls the auth module into the browser bundle.
 */
export function AccountMenu({
  person,
  termLabel,
  signOutAction,
}: {
  person: { id: string; name: string | null; photoVersion: number };
  termLabel: string | null;
  signOutAction: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const itemClasses =
    "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium text-foreground-soft transition-colors hover:bg-muted hover:text-foreground";

  return (
    <div ref={ref} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label="Account menu"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2.5 rounded-full p-0.5 transition-opacity hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
      >
        <PersonPhoto person={person} size={32} />
      </button>

      {open && (
        <div className="glass-panel absolute right-0 top-11 z-40 w-60 overflow-hidden rounded-xl p-1.5">
          <div className="border-b border-border-subtle px-2.5 pb-2.5 pt-1.5">
            <p className="truncate text-sm font-semibold text-foreground">{person.name ?? "Signed in"}</p>
            {termLabel && <p className="mt-0.5 text-xs text-muted-foreground">{termLabel}</p>}
          </div>

          <div className="flex flex-col gap-0.5 py-1.5">
            <Link href="/my-info" onClick={() => setOpen(false)} className={itemClasses}>
              <UserRoundPen aria-hidden className="h-4 w-4" />
              My Info
            </Link>
            <Link href="/training" onClick={() => setOpen(false)} className={itemClasses}>
              <GraduationCap aria-hidden className="h-4 w-4" />
              Training
            </Link>
          </div>

          <form action={signOutAction} className="border-t border-border-subtle pt-1.5">
            <button type="submit" className={`w-full ${itemClasses}`}>
              <LogOut aria-hidden className="h-4 w-4" />
              Sign out
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
