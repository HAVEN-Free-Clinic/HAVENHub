"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { CircleHelp, X } from "lucide-react";
import { seedForPathname } from "./help-context";

// The embed touches window/document, so load it client-only.
const GitBookProvider = dynamic(
  () => import("@gitbook/embed/react").then((m) => m.GitBookProvider),
  { ssr: false }
);
const GitBookFrame = dynamic(
  () => import("@gitbook/embed/react").then((m) => m.GitBookFrame),
  { ssr: false }
);

/** Re-fetch the visitor token this many ms before it expires. */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

type TokenState = { token: string; expiresAt: number } | null;

export function HelpLauncher({
  siteURL,
  moduleLabels,
}: {
  siteURL: string;
  moduleLabels: Record<string, string>;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [tokenState, setTokenState] = useState<TokenState>(null);
  const [error, setError] = useState<string | null>(null);
  const [colorScheme, setColorScheme] = useState<"light" | "dark">("light");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadToken = useCallback(async () => {
    try {
      const res = await fetch("/api/gitbook/embed-token", { cache: "no-store" });
      if (!res.ok) {
        setError(
          res.status === 401 ? "Please sign in to view help." : "Help is unavailable right now."
        );
        setTokenState(null);
        return;
      }
      const json = (await res.json()) as { token: string; expiresAt: number };
      setError(null);
      setTokenState(json);
    } catch {
      setError("Help is unavailable right now.");
      setTokenState(null);
    }
  }, []);

  // Toggling is an event handler (not render/effect), so reading the DOM here is safe and
  // avoids the react-hooks set-state-in-effect rule. Every open re-fetches a fresh token.
  function toggle() {
    const next = !open;
    setOpen(next);
    if (next) {
      setColorScheme(
        document.documentElement.classList.contains("dark") ? "dark" : "light"
      );
      void loadToken();
    }
  }

  // While open with a token, schedule a refresh shortly before it expires. The timeout
  // callback (not the effect body) triggers the async reload, so this is not a
  // synchronous setState-in-effect.
  useEffect(() => {
    if (!open || !tokenState) return;
    const delay = Math.max(0, tokenState.expiresAt - Date.now() - REFRESH_SKEW_MS);
    timer.current = setTimeout(() => void loadToken(), delay);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [open, tokenState, loadToken]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const seed = seedForPathname(pathname ?? "/", moduleLabels);

  return (
    <>
      <button
        type="button"
        onClick={toggle}
        aria-label="Help and documentation"
        aria-haspopup="dialog"
        aria-expanded={open}
        className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
      >
        <CircleHelp aria-hidden className="h-4 w-4" />
      </button>

      {/* Portal to <body>: the app-shell toolbar (glass-bar) uses backdrop-filter,
          which makes it the containing block for position:fixed descendants. Rendered
          inline, this panel would anchor to the toolbar (top) and fly off-screen, so we
          escape to <body> for `fixed` to resolve against the viewport. */}
      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            role="dialog"
            aria-label="Help and documentation"
            className="fixed inset-x-0 bottom-0 z-50 sm:inset-x-auto sm:bottom-4 sm:right-4"
          >
          <div className="glass-panel flex h-[80vh] w-full flex-col overflow-hidden rounded-t-2xl sm:h-[600px] sm:w-[400px] sm:rounded-2xl">
            <div className="flex items-center justify-between border-b border-border-subtle px-4 py-2.5">
              <span className="text-sm font-semibold text-foreground">Help</span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close help"
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
              >
                <X aria-hidden className="h-4 w-4" />
              </button>
            </div>
            <div className="min-h-0 flex-1">
              {error ? (
                <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
                  {error}
                </div>
              ) : tokenState ? (
                <GitBookProvider siteURL={siteURL}>
                  <GitBookFrame
                    visitor={{ token: tokenState.token }}
                    tabs={["assistant", "search", "docs"]}
                    greeting={seed.greeting}
                    suggestions={seed.suggestions}
                    colorScheme={colorScheme}
                    className="h-full w-full"
                  />
                </GitBookProvider>
              ) : (
                <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
                  Loading…
                </div>
              )}
            </div>
          </div>
          </div>,
          document.body
        )}
    </>
  );
}
