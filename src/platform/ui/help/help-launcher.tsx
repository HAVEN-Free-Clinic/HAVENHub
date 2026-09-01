"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { BookOpen, CircleHelp, X } from "lucide-react";
import { seedForPathname, type HelpSeed } from "./help-context";

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

/**
 * One tab, on purpose: switching tabs is broken in the embed, and a single tab cannot be
 * switched away from. Observed on production, clicking the search icon:
 *
 *   [gitbook] create channel with parent window   <- a SECOND time, 18s after the first
 *   Uncaught Error: Minified React error #418     <- hydration mismatch, from GitBook's bundle
 *
 * A second channel means the frame tore down its document and booted a new one. The tab rail
 * exists only because this component posts `configure` over postMessage, @gitbook/embed sends
 * that once at mount and never again, so the new document comes up unconfigured and the rail
 * stops responding -- you can leave the assistant but you cannot get back. Each of those
 * reboots also blocked the main thread for 2-3.5s (Vercel Toolbar INP), and because
 * hub.* and docs.* are the same site they share a renderer process, so the freeze takes the
 * whole app with it, not just the panel.
 *
 * None of that is ours to fix (it is GitBook's app, on 0.5.1, unchanged since May), but not
 * offering the tabs avoids all of it. Search is reachable through the assistant, which
 * searches the docs to answer, and the header link below covers browsing.
 *
 * "docs" was never viable regardless: docs.havenfreeclinic.org serves 404 for
 * /~gitbook/embed/docs, so that icon did nothing at all.
 *
 * Module-level for stable identity: GitBookFrame re-sends its whole `configure` payload
 * whenever any configuration prop changes identity, and a fresh array literal per render
 * would do that on every parent render.
 */
const HELP_TABS: ("assistant" | "search" | "docs")[] = ["assistant"];

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
  // The panel is expensive to build: token round-trip -> lazy embed chunk -> cross-origin frame
  // load, all serialized. It is created on first open and then kept mounted-but-hidden, so
  // reopening is instant. Unmounting on close also left a stale bidc channel (and the permanent
  // window "message" listener it registers) behind on every cycle.
  const [everOpened, setEverOpened] = useState(false);
  const [tokenState, setTokenState] = useState<TokenState>(null);
  const [error, setError] = useState<string | null>(null);
  const [colorScheme, setColorScheme] = useState<"light" | "dark">("light");
  // Snapshotted when the panel opens rather than tracked live: re-seeding a conversation that is
  // already underway has no upside, and each change re-configures the frame underneath the user.
  const [seed, setSeed] = useState<HelpSeed>(() =>
    seedForPathname(pathname ?? "/", moduleLabels)
  );
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const held = useRef<TokenState>(null);
  const inFlight = useRef(false);

  const loadToken = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const res = await fetch("/api/gitbook/embed-token", { cache: "no-store" });
      if (!res.ok) {
        setError(
          res.status === 401 ? "Please sign in to view help." : "Help is unavailable right now."
        );
        setTokenState(null);
        held.current = null;
        return;
      }
      const json = (await res.json()) as { token: string; expiresAt: number };
      setError(null);
      setTokenState(json);
      held.current = json;
    } catch {
      setError("Help is unavailable right now.");
      setTokenState(null);
      held.current = null;
    } finally {
      inFlight.current = false;
    }
  }, []);

  // Minting a token costs a session decode plus several queries, so only spend it when the one
  // we hold is missing or close to expiry. Reopening the panel inside the hour is free.
  const ensureToken = useCallback(() => {
    const current = held.current;
    if (current && current.expiresAt - Date.now() > REFRESH_SKEW_MS) return;
    void loadToken();
  }, [loadToken]);

  // Warm both serial hops (token request, lazy chunk download) on intent rather than on click,
  // so the click only pays for the frame itself.
  const prefetch = useCallback(() => {
    // Caught, and not only to keep a warm-up failure out of Error Tracking: an
    // uncaught rejection here would reach the global handler that
    // chunk-load-recovery.tsx listens on and reload the page under the member
    // over a chunk nobody has asked to see yet. A failed prefetch costs nothing
    // -- next/dynamic re-requests the chunk when the panel actually opens.
    void import("@gitbook/embed/react").catch(() => {});
    ensureToken();
  }, [ensureToken]);

  // Toggling is an event handler (not render/effect), so reading the DOM here is safe and
  // avoids the react-hooks set-state-in-effect rule.
  function toggle() {
    const next = !open;
    setOpen(next);
    if (next) {
      setEverOpened(true);
      setColorScheme(
        document.documentElement.classList.contains("dark") ? "dark" : "light"
      );
      setSeed(seedForPathname(pathname ?? "/", moduleLabels));
      ensureToken();
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

  // Stable identity per token: the frame derives its `src` from this object, so a fresh literal
  // per render makes the embed's own memo recompute the URL on every parent render.
  const visitor = useMemo(
    () => (tokenState ? { token: tokenState.token } : null),
    [tokenState]
  );

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      {/* Persistent floating help bubble, bottom-right on every authenticated page.
          Rendered outside the glass-bar toolbar (see AppShell), so `fixed` anchors to
          the viewport rather than the toolbar's backdrop-filter containing block. */}
      <button
        type="button"
        onClick={toggle}
        onPointerEnter={prefetch}
        onPointerDown={prefetch}
        onFocus={prefetch}
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
          any transformed/filtered ancestor. It floats just above the bubble. Once built it
          stays in the tree; closing hides it with `display:none`, which keeps the iframe's
          document alive (only reparenting the element would reload it). */}
      {everOpened &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            role="dialog"
            aria-label="Help and documentation"
            className={`fixed bottom-24 left-4 right-4 z-50 sm:left-auto sm:right-6 ${
              open ? "" : "hidden"
            }`}
          >
          <div className="glass-panel flex h-[70vh] max-h-[calc(100dvh-8rem)] w-full flex-col overflow-hidden rounded-2xl sm:h-[600px] sm:w-[400px]">
            <div className="flex items-center justify-between border-b border-border-subtle px-4 py-2.5">
              <span className="text-sm font-semibold text-foreground">Help</span>
              <div className="flex items-center gap-1">
                {/* Replaces the embed's docs tab. Opens top-level rather than in the frame:
                    /api/gitbook/auth mints a fresh visitor token and redirects into the site,
                    which is the same path GitBook itself falls back to. */}
                <a
                  href="/api/gitbook/auth"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                >
                  <BookOpen aria-hidden className="h-3.5 w-3.5" />
                  Docs
                  <span className="sr-only">(opens in a new tab)</span>
                </a>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close help"
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                >
                  <X aria-hidden className="h-4 w-4" />
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1">
              {error ? (
                <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
                  {error}
                </div>
              ) : visitor ? (
                <GitBookProvider siteURL={siteURL}>
                  <GitBookFrame
                    visitor={visitor}
                    tabs={HELP_TABS}
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
