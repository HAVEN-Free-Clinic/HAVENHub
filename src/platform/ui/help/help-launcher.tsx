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
      {/* Persistent floating help bubble, bottom-right on every authenticated page.
          Rendered outside the glass-bar toolbar (see AppShell), so `fixed` anchors to
          the viewport rather than the toolbar's backdrop-filter containing block. */}
      <button
        type="button"
        onClick={toggle}
        aria-label={open ? "Close help" : "Help and documentation"}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="fixed bottom-6 right-6 z-50 inline-flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-brand to-brand-deep text-white shadow-lg transition hover:shadow-xl hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
      >
        {open ? (
          <X aria-hidden className="h-6 w-6" />
        ) : (
          <CircleHelp aria-hidden className="h-6 w-6" />
        )}
      </button>

      {/* Portal the panel to <body> so its `fixed` positioning is robust regardless of
          any transformed/filtered ancestor. It floats just above the bubble. */}
      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            role="dialog"
            aria-label="Help and documentation"
            className="fixed bottom-24 left-4 right-4 z-50 sm:left-auto sm:right-6"
          >
          <div className="glass-panel flex h-[70vh] max-h-[calc(100dvh-8rem)] w-full flex-col overflow-hidden rounded-2xl sm:h-[600px] sm:w-[400px]">
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
